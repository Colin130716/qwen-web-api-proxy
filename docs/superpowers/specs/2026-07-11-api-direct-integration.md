# Direct Qwen API Integration — System Prompt Injection & Tool Calling

## Motivation

The current DOM-automation approach (filling textarea + Enter key) has fundamental
limitations:

1. **Qwen detects automated input** — SSE stream is blocked ("Oops! There was an
   issue connecting..."), forcing us to fall back to polling `GET /api/v2/chats/:id`
2. **No control over system prompt** — Cherry Studio's system prompt is discarded;
   we can only type the user message into the chat box
3. **No tool/function calling** — Qwen web itself supports MCP tools, but our
   current approach cannot inject tool definitions
4. **Fragile timing** — `executeDom` requires ~4.2s delays (1200ms + 3000ms),
   creating race conditions with polling

## Solution: Direct API Calls from Content Script

Instead of DOM automation, call Qwen's v2 API directly from the content script.
The content script runs on `chat.qwen.ai` origin, has access to cookies via
`credentials: "include"`, and can read required tokens/headers from the page.

## Qwen v2 API Overview

### Chat Creation
```
POST /api/v2/chats/new
Content-Type: application/json
source: web
version: 0.2.72
x-request-id: <uuid>

{
  "title": "New Chat",
  "models": ["qwen3.7-plus"],
  "chat_mode": "normal",
  "chat_type": "t2t",
  "timestamp": <unix_ms>
}
```

Response:
```json
{
  "success": true,
  "data": { "id": "<chat_id>" }
}
```

### Send Message (SSE)
```
POST /api/v2/chat/completions?chat_id=<chat_id>
Content-Type: application/json
source: web
version: 0.2.72
x-request-id: <uuid>

{
  "stream": true,
  "incremental_output": true,
  "chat_id": "<chat_id>",
  "chat_mode": "normal",
  "model": "qwen3.7-plus",
  "parent_id": null,
  "messages": [{
    "fid": "<uuid>",
    "parentId": null,
    "childrenIds": [],
    "role": "user",
    "content": "<message>",
    "user_action": "chat",
    "files": [],
    "timestamp": <unix_seconds>,
    "models": ["qwen3.7-plus"],
    "chat_type": "t2t",
    "feature_config": {
      "thinking_enabled": true,
      "output_schema": "phase",
      "auto_thinking": true,
      "research_mode": "normal",
      "auto_search": false
    },
    "sub_chat_type": "t2t",
    "parent_id": null
  }]
}
```

### SSE Response Format
```
data: {"choices":[{"delta":{"phase":"think","content":"thinking text..."}}]}
data: {"choices":[{"delta":{"phase":"thinking_summary","content":"summary..."}}]}
data: {"choices":[{"delta":{"phase":"answer","content":"answer text..."}}]}
data: [DONE]
```

Phases:
- `think` / `thinking_summary` → reasoning content
- `answer` → assistant content (final answer)
- null/absent `phase` → also assistant content

## Architecture

### Phase 1: Direct API Call (Replace DOM Automation)

```
┌─────────────┐     ┌──────────────┐     ┌───────────┐
│ Cherry      │     │ Proxy Server │     │ Extension │
│ Studio      │────▶│ (FastAPI)    │────▶│ (Content  │
│             │     │              │     │  Script)  │
└─────────────┘     └──────────────┘     └─────┬─────┘
                                               │
                                      ┌────────▼────────┐
                                      │ Qwen v2 API     │
                                      │ chat.qwen.ai    │
                                      │ POST /chats/new │
                                      │ POST /chat/     │
                                      │   completions   │
                                      └─────────────────┘
```

Flow:
1. Cherry Studio → HTTP POST → Proxy Server
2. Proxy → WebSocket `execute` → Content Script
3. Content Script → `POST /api/v2/chats/new` → gets `chatId`
4. Content Script → `POST /api/v2/chat/completions?chat_id=` → SSE stream
5. Content Script parses SSE, sends `reasoning`/`chunk`/`done` via WebSocket
6. Proxy assembles OpenAI-format response → HTTP response to Cherry Studio

### Phase 2: System Prompt Injection

When Cherry Studio sends a request with a `system` role message:

```
messages: [
  { role: "system", content: "You are a helpful assistant..." },
  { role: "user", content: "Hello!" }
]
```

The content script folds it into the Qwen user message:

```
content: "System instructions:\nYou are a helpful assistant...\n\nUser: Hello!"
```

This matches the `foldMessages` pattern from OmniRoute. The Qwen model
understands this convention and follows the system instructions.

### Phase 3: Tool Calling Support

When Cherry Studio sends a request with `tools`:

```json
{
  "messages": [{"role": "user", "content": "What's the weather?"}],
  "tools": [{
    "type": "function",
    "function": {
      "name": "get_weather",
      "description": "Get weather for a city",
      "parameters": {...}
    }
  }]
}
```

The content script:
1. Injects tool definitions into the system prompt:
   ```
   You have access to the following tools:
   
   ## get_weather
   Description: Get weather for a city
   Parameters:
   - city (string, required): City name
   
   To call a tool, respond with:
   <tool_call>
   {"name": "get_weather", "arguments": {"city": "Beijing"}}
   </tool_call>
   ```

2. Sends the message to Qwen
3. Parses the response for `<tool_call>` blocks
4. Converts to OpenAI `tool_calls` format

### Phase 4: Multi-Turn Tool Calls

For multi-turn tool use (where the tool result needs to be sent back):
1. Proxy receives `tool_result` messages from Cherry Studio
2. Content script sends them as additional user messages
3. Qwen integrates the results into its response

## Implementation Plan

### Step 1: Header Discovery

The content script runs on `chat.qwen.ai` origin, so the browser automatically includes
cookies, Origin, and Referer. No `bx-v`, `bx-umidtoken`, or explicit `Authorization`
header needed — the session is authenticated via cookies + `credentials: "include"`.

The only custom headers needed:
- `source: web` — expected by the API
- `version: <SPA version>` — hardcode with periodic update from page's config API
- `x-request-id: <uuid>` — generated fresh per request

```typescript
const QWEN_SPA_VERSION = "0.2.72"; // Update from GET /api/v2/configs/

function getQwenHeaders(): Record<string, string> {
  return {
    "source": "web",
    "version": QWEN_SPA_VERSION,
    "x-request-id": crypto.randomUUID(),
    "Content-Type": "application/json",
  };
}
```

### Step 2: Chat Creation

```typescript
async function createQwenChat(modelId: string): Promise<string> {
  const resp = await fetch("https://chat.qwen.ai/api/v2/chats/new", {
    method: "POST",
    credentials: "include",
    headers: getQwenHeaders(),
    body: JSON.stringify({
      title: "New Chat",
      models: [modelId],
      chat_mode: "normal",
      chat_type: "t2t",
      timestamp: Date.now(),
    }),
  });
  const data = await resp.json();
  return data.data.id;
}
```

### Step 3: Send Message & Parse SSE

```typescript
async function* sendQwenMessage(
  chatId: string,
  modelId: string,
  messages: { role: string; content: string }[],
): AsyncGenerator<{ type: "reasoning" | "chunk" | "done"; content?: string; usage?: any }> {
  
  // Fold system + user messages
  const prompt = foldMessages(messages);
  
  const resp = await fetch(
    `https://chat.qwen.ai/api/v2/chat/completions?chat_id=${chatId}`,
    {
      method: "POST",
      credentials: "include",
      headers: getQwenHeaders(),
      body: JSON.stringify(buildPayload(chatId, modelId, prompt)),
    },
  );

  // Parse SSE stream
  const reader = resp.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";
    
    for (const line of lines) {
      const delta = parseQwenSSEDelta(line);
      if (!delta || !delta.text) continue;
      
      if (delta.kind === "think") {
        yield { type: "reasoning", content: delta.text };
      } else if (delta.kind === "answer") {
        yield { type: "chunk", content: delta.text };
      }
    }
  }
  
  yield { type: "done" };
}
```

### Step 4: Tool Call Formatting

For tool definitions, inject a structured system prompt:

```typescript
function injectToolDefinitions(
  messages: { role: string; content: string }[],
  tools: ToolDefinition[],
): string {
  let system = "";
  for (const m of messages) {
    if (m.role === "system") system += m.content + "\n";
  }
  
  const toolPrompt = tools.length > 0
    ? "\n\nYou have access to the following tools:\n" +
      tools.map(t => formatToolDef(t)).join("\n\n") +
      "\n\nTo call a tool, respond with:\n<tool_call>\n{\"name\": \"...\", \"arguments\": {...}}\n</tool_call>"
    : "";
  
  return system + toolPrompt;
}

function parseToolCalls(text: string): ToolCall[] | null {
  const regex = /<tool_call>\s*({.*?})\s*<\/tool_call>/gs;
  const calls: ToolCall[] = [];
  let match;
  while ((match = regex.exec(text)) !== null) {
    try {
      calls.push(JSON.parse(match[1]));
    } catch {}
  }
  return calls.length > 0 ? calls : null;
}
```

## Required Changes

### New Files
- `browser-extension/src/lib/qwen_api.ts` — Qwen API client (create chat, send message, SSE parser)
- `browser-extension/src/lib/tool_calling.ts` — Tool definition injection & tool call parser

### Modified Files
- `browser-extension/src/content_script.ts` — Replace execute handler to use direct API instead of DOM automation
- `proxy_server/server/api.py` — Pass `tools` field from request to extension
- `proxy_server/server/openai_format.py` — Support tool_calls in response format

### Removed/Deprecated
- `page_script.js` — No longer needed (no SSE interception)
- `service_worker.ts` `executeDomInMainWorld` — No longer needed
- DOM automation functions (`fillInput`, `clickSend`, `simulateUserType`)

## Risks & Mitigations

| Risk | Mitigation |
|------|------------|
| WAF blocks direct API calls | Content script runs on `chat.qwen.ai` origin with cookies; `credentials: "include"` sends session cookies automatically. If `bx-v`/`bx-umidtoken` headers are required, read from page's XHR intercepts |
| SPA version changes | Hardcode with comment noting last verified version; add periodic re-read from `GET /api/v2/configs/` `cdn_version` field |
| SSE format changes | Robust parser handling `phase` = `think`, `thinking_summary`, `answer`, `null`/`undefined` |
| Create chat per request (overhead) | ~500ms latency per call; acceptable for typical usage. Future: pool/reuse chats |
| Rate limiting | Single request at a time (already enforced by pendingRequest) |

## Future Enhancements

1. **Chat reuse** — Instead of creating a new chat for every request, reuse existing chats for conversation continuity
2. **File upload** — Support image/file attachments via Qwen's file upload API
3. **Model selection** — Allow user to pick model (Plus/Max/Flash) via Cherry Studio model mapping
4. **Streaming** — Forward SSE stream directly to client for real-time output
