# API Interception Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace DOM automation with direct Qwen API calls from the content script, adding thinking/reasoning content extraction.

**Architecture:** Content script uses `fetch()` with `credentials: 'include'` to call Qwen's backend API directly, bypassing the page DOM. The SSE stream from Qwen's API is parsed to extract `thinking_summary` (reasoning) and `answer` (content) phases. A new `reasoning` WebSocket message type carries the thinking content to the proxy, which adds `reasoning_content` to OpenAI-format responses.

**Tech Stack:** TypeScript + Vite (extension), Python + FastAPI (proxy), Qwen API v2

## Global Constraints

- Content script must be self-contained (no `import` statements in Vite output for Chrome MV3 compatibility)
- All SSE parsing happens in-browser (content script)
- WebSocket protocol extended with `reasoning` message type
- OpenAI `reasoning_content` field added to both streaming (`delta`) and non-streaming (`message`) responses
- The `chat_id` is fetched from `GET /api/v2/chats/?page=1&exclude_project=true` and cached for 60s
- Only the last user message from OpenAI format is forwarded
- Model hardcoded to `qwen3.7-plus` with thinking enabled

---

### Task 1: Add `reasoning_content` to OpenAI format helpers

**Files:**
- Modify: `proxy_server/server/openai_format.py` (lines 13-66)

**Interfaces:**
- Consumes: nothing from other tasks
- Produces:
  - `create_chat_chunk(content, *, reasoning_content=None, finish_reason=None)` — new `reasoning_content` kwarg
  - `create_chat_completion_response(content, *, reasoning_content=None, ...)` — new `reasoning_content` kwarg

- [ ] **Step 1: Update `create_chat_chunk` to accept `reasoning_content`**

In `openai_format.py`, replace the function:

```python
def create_chat_chunk(
    content: str,
    model: str = "qwen-web",
    finish_reason: str | None = None,
    reasoning_content: str | None = None,
) -> str:
    """Create a streaming SSE data line for a single content chunk."""
    delta: dict[str, Any] = {}
    if reasoning_content:
        delta["reasoning_content"] = reasoning_content
    if content:
        delta["content"] = content
    chunk: dict[str, Any] = {
        "id": _generate_id(),
        "object": "chat.completion.chunk",
        "created": int(time.time()),
        "model": model,
        "choices": [
            {
                "index": 0,
                "delta": delta,
                "finish_reason": finish_reason,
                "logprobs": None,
            }
        ],
        "system_fingerprint": "fp_qwen_proxy",
    }
    return f"data: {json.dumps(chunk)}\n\n"
```

- [ ] **Step 2: Update `create_chat_completion_response` to accept `reasoning_content`**

```python
def create_chat_completion_response(
    content: str,
    model: str = "qwen-web",
    prompt_tokens: int = 0,
    completion_tokens: int = 0,
    reasoning_content: str | None = None,
) -> dict[str, Any]:
    """Create a non-streaming OpenAI Chat Completions response."""
    message: dict[str, Any] = {
        "role": "assistant",
        "content": content,
    }
    if reasoning_content:
        message["reasoning_content"] = reasoning_content
    return {
        "id": _generate_id(),
        "object": "chat.completion",
        "created": int(time.time()),
        "model": model,
        "choices": [
            {
                "index": 0,
                "message": message,
                "finish_reason": "stop",
                "logprobs": None,
            }
        ],
        "usage": {
            "prompt_tokens": prompt_tokens or estimate_token_count(""),
            "completion_tokens": completion_tokens or estimate_token_count(content),
            "total_tokens": (prompt_tokens or 0) + (completion_tokens or 0),
        },
        "system_fingerprint": "fp_qwen_proxy",
    }
```

- [ ] **Step 3: Verify the file parses correctly**

```bash
cd proxy_server && python -c "from proxy_server.server.openai_format import create_chat_chunk, create_chat_completion_response; print('OK')"
```

Expected: `OK`

---

### Task 2: Pipe reasoning through proxy API routes

**Files:**
- Modify: `proxy_server/server/api.py` (lines 110-193)

**Interfaces:**
- Consumes:
  - `create_chat_chunk(content, *, reasoning_content=None, finish_reason=None)` from Task 1
  - `create_chat_completion_response(content, *, reasoning_content=None, ...)` from Task 1
  - `manager.send_json(data)` — sends execute command to extension
  - `manager.receive_json()` — receives `reasoning`, `chunk`, `done`, `error` message types
- Produces:
  - `_execute_non_streaming()` returns `(content, reasoning_content)` tuple
  - `_stream_response()` yields reasoning SSE chunk before answer chunks

- [ ] **Step 1: Update `_execute_non_streaming` to collect `reasoning` messages**

Replace lines 110-143:

```python
async def _execute_non_streaming(
    request_id: str, messages: list[dict[str, str]]
) -> tuple[str, str | None]:
    """Send messages to Qwen via WebSocket and collect the complete response.
    Returns (content, reasoning_content).
    """
    await manager.send_json({
        "type": "execute",
        "id": request_id,
        "messages": messages,
    })

    full_content = ""
    reasoning_content: str | None = None
    timeout = REQUEST_TIMEOUT

    while True:
        try:
            resp = await asyncio.wait_for(manager.receive_json(), timeout=timeout)
        except asyncio.TimeoutError:
            raise

        msg_type = resp.get("type")

        if msg_type == "reasoning":
            reasoning_content = resp.get("content", "")
            timeout = 30.0

        elif msg_type == "chunk":
            content = resp.get("data", {}).get("content", "")
            full_content += content
            timeout = 30.0

        elif msg_type == "done":
            break

        elif msg_type == "error":
            error_msg = resp.get("error", {}).get("message", "Unknown error")
            raise RuntimeError(error_msg)

    return full_content, reasoning_content
```

- [ ] **Step 2: Update `_stream_response` to yield reasoning before answer chunks**

Replace lines 146-193:

```python
async def _stream_response(
    request_id: str, messages: list[dict[str, str]]
) -> AsyncGenerator[str, None]:
    """Stream responses from Qwen to the client via SSE."""
    await manager.send_json({
        "type": "execute",
        "id": request_id,
        "messages": messages,
        "options": {"stream": True},
    })

    timeout = REQUEST_TIMEOUT

    try:
        while True:
            try:
                resp = await asyncio.wait_for(
                    manager.receive_json(), timeout=timeout
                )
            except asyncio.TimeoutError:
                yield create_chat_chunk("", finish_reason="error")
                yield create_done_signal()
                return

            msg_type = resp.get("type")

            if msg_type == "reasoning":
                yield create_chat_chunk("", reasoning_content=resp.get("content", ""))
                timeout = 30.0

            elif msg_type == "chunk":
                content = resp.get("data", {}).get("content", "")
                yield create_chat_chunk(content)
                timeout = 30.0

            elif msg_type == "done":
                yield create_chat_chunk("", finish_reason="stop")
                yield create_done_signal()
                return

            elif msg_type == "error":
                error_msg = resp.get("error", {}).get("message", "Unknown error")
                yield create_chat_chunk(
                    f"[Error: {error_msg}]", finish_reason="error"
                )
                yield create_done_signal()
                return

    except Exception as e:
        logger.exception("Streaming error")
        yield create_chat_chunk("", finish_reason="error")
        yield create_done_signal()
```

- [ ] **Step 3: Update `chat_completions` route to handle tuple return from `_execute_non_streaming`**

Replace lines 89-97 (the `else` block in `chat_completions`):

```python
        else:
            try:
                full_content, reasoning_content = await _execute_non_streaming(
                    request_id, messages
                )
                return create_chat_completion_response(
                    full_content, reasoning_content=reasoning_content
                )
            except asyncio.TimeoutError:
                raise HTTPException(
                    status_code=status.HTTP_408_REQUEST_TIMEOUT,
                    detail="Request timeout",
                )
            except Exception as e:
                logger.exception("Non-streaming request failed")
                raise HTTPException(status_code=502, detail=str(e))
```

- [ ] **Step 4: Update the import to include `reasoning_content`**

No import change needed — `create_chat_chunk` and `create_chat_completion_response` support `reasoning_content` via kwargs with defaults.

- [ ] **Step 5: Verify the file parses correctly**

```bash
cd proxy_server && python -c "from proxy_server.server.api import create_app; print('OK')"
```

Expected: `OK`

---

### Task 3: Rewrite content_script.ts — replace DOM with fetch + SSE

**Files:**
- Modify: `browser-extension/src/content_script.ts` (full rewrite, keep only WsBridge class)

**Interfaces:**
- Consumes:
  - WebSocket messages: `{type: "execute", id, messages, options?: {stream}}`
- Produces:
  - WebSocket messages: `{type: "reasoning", id, content}`, `{type: "chunk", id, data: {content, done}}`, `{type: "done", id, usage}`, `{type: "error", id, error}`

- [ ] **Step 1: Delete DOM automation functions, keep WsBridge and types**

Keep lines 1-138 (types, defaults, WsBridge class). Delete everything from line 140 onward.

- [ ] **Step 2: Write the new `main()` function**

```typescript
// ── Content Script Logic ─────────────────────────────
console.log("[QwenProxy] Content script loaded (API interception mode)");

// Cache for chat_id (60s TTL)
let chatIdCache: { chatId: string; expires: number } | null = null;

async function getChatId(): Promise<string> {
  if (chatIdCache && Date.now() < chatIdCache.expires) {
    return chatIdCache.chatId;
  }
  const resp = await fetch(
    "https://chat.qwen.ai/api/v2/chats/?page=1&exclude_project=true",
    { credentials: "include" },
  );
  if (!resp.ok) {
    throw new Error(
      `Failed to fetch chat list (HTTP ${resp.status}). Please ensure you are logged in to chat.qwen.ai.`,
    );
  }
  const body = await resp.json();
  const chatId: string | undefined = body?.data?.[0]?.id;
  if (!chatId) {
    throw new Error("No chats found on Qwen. Please start a conversation on chat.qwen.ai first.");
  }
  chatIdCache = { chatId, expires: Date.now() + 60000 };
  return chatId;
}

async function main(): Promise<void> {
  const config: ProxyConfig = await new Promise((resolve) => {
    chrome.storage.sync.get(
      ["proxyHost", "proxyPort", "apiKey"],
      (items) => {
        resolve({
          proxyHost: (items.proxyHost as string) || DEFAULT_CONFIG.proxyHost,
          proxyPort: (items.proxyPort as number) || DEFAULT_CONFIG.proxyPort,
          apiKey: (items.apiKey as string) || DEFAULT_CONFIG.apiKey,
        });
      },
    );
  });

  const bridge = new WsBridge(config.proxyHost, config.proxyPort);
  bridge.connect();

  bridge.onMessage(async (msg: any) => {
    if (msg.type === "execute") {
      console.debug("[ContentScript] Received execute command:", msg.id);
      try {
        await executeQwenApi(msg.id, msg.messages, bridge);
      } catch (error) {
        bridge.send({
          type: "error",
          id: msg.id,
          error: {
            message: error instanceof Error ? error.message : "Unknown error",
          },
        });
      }
    }
  });

  chrome.runtime.onMessage.addListener((message: any) => {
    if (message.type === "configUpdated") {
      bridge.disconnect();
    }
  });

  chrome.runtime.sendMessage({ type: "contentScriptReady" });
}
```

- [ ] **Step 3: Write the `executeQwenApi` function**

```typescript
async function executeQwenApi(
  requestId: string,
  messages: { role: string; content: string }[],
  bridge: WsBridge,
): Promise<void> {
  const lastUserMessage = messages.filter((m) => m.role === "user").pop();
  if (!lastUserMessage) throw new Error("No user message found");

  const chatId = await getChatId();

  const qwenMessages = [{
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
      auto_search: true,
    },
    extra: { meta: { subChatType: "t2t" } },
    sub_chat_type: "t2t",
    parent_id: null,
  }];

  const requestBody = {
    stream: true,
    version: "2.1",
    incremental_output: true,
    chat_id: chatId,
    chat_mode: "normal",
    model: "qwen3.7-plus",
    parent_id: null,
    messages: qwenMessages,
    timestamp: Date.now(),
  };

  const url = `https://chat.qwen.ai/api/v2/chat/completions?chat_id=${encodeURIComponent(chatId)}`;

  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify(requestBody),
  });

  if (!response.ok) {
    // Try refreshing chat_id once on 4xx
    if (response.status >= 400 && response.status < 500) {
      chatIdCache = null;
      const newChatId = await getChatId();
      requestBody.chat_id = newChatId;
      const newUrl = `https://chat.qwen.ai/api/v2/chat/completions?chat_id=${encodeURIComponent(newChatId)}`;
      const retryResp = await fetch(newUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify(requestBody),
      });
      if (!retryResp.ok) {
        throw new Error(`Qwen API error: HTTP ${retryResp.status}`);
      }
      // Continue with retryResp below
      await parseSSEStream(retryResp, requestId, bridge);
      return;
    }
    throw new Error(`Qwen API error: HTTP ${response.status}`);
  }

  await parseSSEStream(response, requestId, bridge);
}
```

- [ ] **Step 4: Write the `parseSSEStream` function**

```typescript
async function parseSSEStream(
  response: Response,
  requestId: string,
  bridge: WsBridge,
): Promise<void> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Response body is not readable");

  const decoder = new TextDecoder();
  let buffer = "";
  let thinkingContent = "";
  let thinkingFinished = false;
  let hasSentThinking = false;
  let lastDataTime = Date.now();
  const timeout = 120000; // 2min

  try {
    while (true) {
      // Check timeout
      if (Date.now() - lastDataTime > 60000) {
        // 60s without any data
        throw new Error("Qwen API timeout: no data received for 60s");
      }

      const { done, value } = await reader.read();
      if (done) break;

      lastDataTime = Date.now();
      buffer += decoder.decode(value, { stream: true });

      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data: ")) continue;
        const raw = trimmed.slice(6);
        if (raw === "[DONE]") continue;

        let event: any;
        try {
          event = JSON.parse(raw);
        } catch {
          continue; // Skip malformed events
        }

        // Handle response.created (chat session init)
        if (event["response.created"]) continue;

        const choice = event?.choices?.[0];
        if (!choice?.delta) continue;

        const delta = choice.delta;
        const phase = delta.phase;

        if (phase === "thinking_summary") {
          // Accumulate thinking content
          if (delta.extra?.summary_thought?.content) {
            const thoughts = delta.extra.summary_thought.content;
            if (Array.isArray(thoughts)) {
              thinkingContent += thoughts.join("\n");
            } else {
              thinkingContent += String(thoughts);
            }
          }
          if (delta.status === "finished") {
            thinkingFinished = true;
          }
        } else if (phase === "answer") {
          // Send thinking first (once, before first answer chunk)
          if (thinkingFinished && !hasSentThinking && thinkingContent) {
            bridge.send({
              type: "reasoning",
              id: requestId,
              content: thinkingContent,
            });
            hasSentThinking = true;
          }
          // Send answer content
          const content = delta.content || "";
          if (content) {
            bridge.send({
              type: "chunk",
              id: requestId,
              data: { content, done: false },
            });
          }
          if (delta.status === "finished") {
            // Send any remaining thinking that wasn't sent
            if (!hasSentThinking && thinkingContent) {
              bridge.send({
                type: "reasoning",
                id: requestId,
                content: thinkingContent,
              });
            }
            const usage = event.usage || {
              input_tokens: 0,
              output_tokens: 0,
              total_tokens: 0,
            };
            bridge.send({
              type: "done",
              id: requestId,
              usage: {
                prompt_tokens: usage.input_tokens || 0,
                completion_tokens: usage.output_tokens || 0,
                total_tokens: usage.total_tokens || 0,
              },
            });
            return;
          }
        }
      }
    }
    // Stream ended without finished signal
    throw new Error("Qwen response stream ended unexpectedly");
  } finally {
    reader.cancel().catch(() => {});
  }
}
```

- [ ] **Step 5: Verify the build compiles without errors**

```bash
cd browser-extension && npm run build 2>&1 && npx tsc --noEmit 2>&1
```

Expected: build succeeds, tsc returns no errors (exit 0).

---

### Task 4: Integration smoke test

- [ ] **Step 1: Start the proxy server**

```bash
cd proxy_server && python -m proxy_server 2>&1 &
```

Expected: Server starts on http://127.0.0.1:11434

- [ ] **Step 2: Load the extension in Chrome**

1. Open `chrome://extensions`
2. Enable Developer mode
3. Load unpacked → select `browser-extension/dist`
4. Open `chat.qwen.ai` in a new tab (ensure logged in)

- [ ] **Step 3: Verify health endpoint reflects connected state**

```bash
curl http://127.0.0.1:11434/health
```

Expected: `{"status":"ok","extension_connected":true}`

- [ ] **Step 4: Test non-streaming chat completion**

```bash
curl http://127.0.0.1:11434/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer sk-qwen-proxy" \
  -d '{"messages":[{"role":"user","content":"你好"}],"stream":false}'
```

Expected: JSON response with `message.content` (answer) and `message.reasoning_content` (thinking).

- [ ] **Step 5: Test streaming chat completion**

```bash
curl -N http://127.0.0.1:11434/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer sk-qwen-proxy" \
  -d '{"messages":[{"role":"user","content":"你好"}],"stream":true}'
```

Expected: SSE stream with `delta.reasoning_content` (first event) followed by `delta.content` events.
