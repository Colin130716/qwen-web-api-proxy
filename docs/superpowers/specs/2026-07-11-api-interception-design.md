# API Interception Architecture — Replace DOM Automation with Direct Qwen API Calls

## Problem

The current proxy relies on DOM automation (typing into Qwen's input box, clicking send, scraping textContent) to interact with Qwen. This approach:

1. Cannot reliably extract thinking/reasoning content (mixed with DOM text)
2. Breaks when Qwen updates their UI (selectors, element structure)
3. Slow (must wait for UI rendering and animations)
4. Fragile (React controlled inputs, timing issues)

## Solution

Replace DOM automation with direct API calls from the content script to Qwen's backend API (`https://chat.qwen.ai/api/v2/chat/completions`), using the browser's authentication context (`credentials: 'include'`).

## Architecture

```
Client → Proxy (OpenAI format)
       → WebSocket → Content Script
       → fetch('https://chat.qwen.ai/api/v2/chat/completions', {credentials: 'include'})
       → Parse SSE stream (extract thinking_summary + answer)
       → WebSocket ← Content Script
       → Proxy (OpenAI format with reasoning_content) → Client
```

### Components Unchanged
- **Proxy server** (`api.py`, `ws_manager.py`, `auth.py`, `config.py`) — WebSocket interface unchanged
- **Service worker** (`service_worker.ts`) — unchanged
- **Popup** (`popup/popup.ts`) — unchanged
- **Types** (`lib/types.ts`) — unchanged

### Components Rewritten
- **Content script** (`content_script.ts`) — delete all DOM automation (~200 lines), replace with `fetch` + SSE parsing (~150 lines)
- **OpenAI format** (`openai_format.py`) — add `reasoning_content` field support
- **API routes** (`api.py`) — pipe reasoning_content through streaming/non-streaming paths

## Content Script Design

### 1. Chat ID Management

On startup, fetch the latest chat ID from Qwen's chats API:

```
GET https://chat.qwen.ai/api/v2/chats/?page=1&exclude_project=true
Headers: (browser auto-attaches cookies via credentials:'include')

Response: {"success": true, "data": [{"id": "4e731367-...", ...}, ...]}
```

- Take the **first item's `id`** as the current chat_id
- Cache for 60 seconds (new chats created by user should be picked up)
- If fetch fails (401/empty), report error and stop

### 2. Message Construction

When an `execute` message arrives from the proxy, construct the Qwen API request body:

| Field | Value | Source |
|-------|-------|--------|
| `stream` | `true` | fixed |
| `version` | `"2.1"` | fixed |
| `incremental_output` | `true` | fixed |
| `chat_id` | `<latest from API>` | from step 1 |
| `chat_mode` | `"normal"` | fixed |
| `model` | `"qwen3.7-plus"` | fixed |
| `parent_id` | `null` | fixed |
| `messages[0]` | last user message | converted from OpenAI format |
| `timestamp` | `Date.now()` | generated |

Message conversion:

```typescript
{
  id: null,
  fid: crypto.randomUUID(),
  parentId: null,
  childrenIds: [crypto.randomUUID()],
  role: "user",
  content: lastUserMessage.content,
  user_action: "chat",
  files: [],
  timestamp: Date.now(),
  models: ["qwen3.7-plus"],
  model: "",
  chat_type: "t2t",
  feature_config: {
    thinking_enabled: true,
    output_schema: "phase",
    research_mode: "normal",
    auto_thinking: false,
    thinking_mode: "Thinking",
    thinking_format: "summary",
    auto_search: true
  },
  extra: {meta: {subChatType: "t2t"}},
  sub_chat_type: "t2t",
  parent_id: null
}
```

Only the **last user message** is sent (not full history). Qwen's API maintains context server-side based on the chat_id.

### 3. SSE Stream Parsing

Use `fetch()` with `Response.body.getReader()` to stream-read the SSE response:

```typescript
const response = await fetch(url, {
  method: 'POST',
  headers: {'Content-Type': 'application/json'},
  credentials: 'include',
  body: JSON.stringify(requestBody)
});

const reader = response.body.getReader();
const decoder = new TextDecoder();
let buffer = '';

while (true) {
  const {done, value} = await reader.read();
  if (done) break;
  buffer += decoder.decode(value, {stream: true});
  
  const lines = buffer.split('\n');
  buffer = lines.pop() || '';
  
  for (const line of lines) {
    if (!line.startsWith('data: ')) continue;
    const json = JSON.parse(line.slice(6));
    processEvent(json);
  }
}
```

### 4. SSE Event Processing

```
on SSE event:
  if event has "response.created":
    save response_id
    
  if choices[0].delta.phase === "thinking_summary":
    accumulate thinking_content from extra.summary_thought.content
    if status === "finished":
      send {type: "reasoning", id, content: accumulatedThinking} via WebSocket
      
  if choices[0].delta.phase === "answer":
    send {type: "chunk", id, data: {content, done: false}} via WebSocket
    if status === "finished":
      send {type: "done", id, usage} via WebSocket
```

### 5. Error Handling

- **401/302** from fetch → "请先登录 chat.qwen.ai" error
- **4xx** from fetch → try refreshing chat_id, retry once
- **Network error** → "无法连接到 Qwen API" error
- **SSE parse error** → skip malformed event, continue
- **Timeout** (no data for 60s) → abort fetch, send error

## WebSocket Protocol Extension

New message type from content script → proxy:

```json
{"type": "reasoning", "id": "req-xxx", "content": "思考文本..."}
```

Sent once after thinking completes, before any answer chunks.

## Proxy Server Changes

### openai_format.py

```python
def create_chat_chunk(content: str, *, reasoning_content: str | None = None, finish_reason: str | None = None) -> str:
    delta = {}
    if reasoning_content:
        delta["reasoning_content"] = reasoning_content
    if content:
        delta["content"] = content
    if not reasoning_content and not content:
        delta = {}
    # ... rest unchanged

def create_chat_completion_response(content: str, *, reasoning_content: str | None = None, ...) -> dict:
    message = {"role": "assistant", "content": content}
    if reasoning_content:
        message["reasoning_content"] = reasoning_content
    # ... rest unchanged
```

### api.py

```python
async def _execute_non_streaming(request_id, messages):
    await manager.send_json({"type": "execute", "id": request_id, "messages": messages})
    full_content = ""
    reasoning_content = None
    while True:
        resp = await manager.receive_json()
        if resp["type"] == "reasoning":
            reasoning_content = resp["content"]
        elif resp["type"] == "chunk":
            full_content += resp["data"]["content"]
        elif resp["type"] == "done":
            break
        elif resp["type"] == "error":
            raise RuntimeError(resp["error"]["message"])
    return create_chat_completion_response(full_content, reasoning_content=reasoning_content)

async def _stream_response(request_id, messages):
    await manager.send_json({"type": "execute", "id": request_id, "messages": messages, "options": {"stream": True}})
    reasoning_sent = False
    while True:
        resp = await manager.receive_json()
        if resp["type"] == "reasoning":
            yield create_chat_chunk("", reasoning_content=resp["content"])
            reasoning_sent = True
        elif resp["type"] == "chunk":
            yield create_chat_chunk(resp["data"]["content"])
        elif resp["type"] == "done":
            yield create_chat_chunk("", finish_reason="stop")
            yield create_done_signal()
            return
        elif resp["type"] == "error":
            yield create_chat_chunk(f"[Error: {resp['error']['message']}]", finish_reason="error")
            yield create_done_signal()
            return
```

## Removed Code

Entire DOM automation module deleted from `content_script.ts`:
- `findInputElement()` — no longer needed
- `fillInput()` — no longer needed
- `clickSend()` — no longer needed
- `streamResponse()` — replaced with fetch + SSE parsing
- `getAssistantMessages()` — no longer needed
- `cleanResponseText()` — no longer needed
- `delay()` — still used for WebSocket reconnection

## Files Changed

| File | Change |
|------|--------|
| `browser-extension/src/content_script.ts` | Rewrite: fetch API + SSE parsing, remove DOM automation |
| `proxy_server/server/openai_format.py` | Add `reasoning_content` param to chunk and completion response |
| `proxy_server/server/api.py` | Pipe reasoning_content through streaming/non-streaming paths |

## Testing

1. Health check + model list (unchanged)
2. Non-streaming chat: verify response includes `reasoning_content` in message
3. Streaming chat: verify `delta.reasoning_content` appears before `delta.content`
4. Error: test without being logged in → proper 503 error
5. Timeout: test with no response → 408 error
6. Chat_id refresh: manually create new chat on Qwen page → proxy picks it up
