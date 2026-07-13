# Phase 1: Direct Qwen API Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace DOM automation with direct Qwen v2 API calls from the content script, enabling system prompt injection and eliminating SSE detection failures.

**Architecture:** Content script makes `POST /api/v2/chats/new` and `POST /api/v2/chat/completions?chat_id=` calls directly from `chat.qwen.ai` origin (with `credentials: "include"`), parses the phase-based SSE stream, and sends results via the existing WebSocket bridge. DOM automation + polling remain as fallback.

**Tech Stack:** TypeScript (MV3 extension), Qwen v2 REST API, SSE streaming

## Global Constraints

- Content script runs on `chat.qwen.ai` / `chat.qwenlm.ai` origin
- All API calls use `credentials: "include"` for cookie-based auth
- No new npm dependencies
- Existing bridge/WsBridge/proxy server remain unchanged
- Keep DOM automation + polling as fallback (do NOT delete existing code)
- SPA version header: `"0.2.72"` (update if Qwen changes)

---
## File Structure

### New Files
- `browser-extension/src/lib/qwen_api.ts` — Qwen API client
  - `getQwenHeaders()` → header map
  - `createQwenChat(modelId)` → `Promise<string>` (chatId)
  - `sendQwenMessage(chatId, modelId, prompt)` → `AsyncGenerator<QwenSSEEvent>`
  - `foldMessages(messages)` → `string` (merged prompt)
  - `parseQwenSSEDelta(line)` → `{ kind, text } | null`
  - Types: `QwenSSEEvent`, `QwenDelta`

### Modified Files
- `browser-extension/src/content_script.ts` — execute handler: try API first, fallback to DOM
- `browser-extension/vite.config.ts` — no changes needed (auto-bundles new files)

---
### Task 1: Write Qwen API Client (`qwen_api.ts`)

**Files:**
- Create: `browser-extension/src/lib/qwen_api.ts`
- Test: `(tested via integration in Task 2)`

**Interfaces:**
- Consumes: nothing (standalone utility)
- Produces: `getQwenHeaders()`, `createQwenChat()`, `sendQwenMessage()`, `foldMessages()`, `parseQwenSSEDelta()`, `QwenSSEEvent`, `QwenDelta`

- [ ] **Step 1: Define types and constants**

```typescript
// browser-extension/src/lib/qwen_api.ts

export interface QwenSSEEvent {
  type: "reasoning" | "chunk" | "done";
  content?: string;
  usage?: { input_tokens: number; output_tokens: number; total_tokens: number };
}

export interface QwenDelta {
  kind: "think" | "answer";
  text: string;
}

const QWEN_SPA_VERSION = "0.2.72";
const BASE_URL = "https://chat.qwen.ai";

function uuid(): string {
  return crypto.randomUUID();
}
```

- [ ] **Step 2: Implement header builder**

```typescript
export function getQwenHeaders(): Record<string, string> {
  return {
    "source": "web",
    "version": QWEN_SPA_VERSION,
    "x-request-id": uuid(),
    "Content-Type": "application/json",
  };
}
```

- [ ] **Step 3: Implement message folding**

```typescript
export function foldMessages(
  messages: { role: string; content: string }[],
): string {
  let systemParts: string[] = [];
  let userContent = "";
  for (const m of messages) {
    if (m.role === "system") {
      systemParts.push(m.content);
    } else if (m.role === "user") {
      userContent = m.content;
    }
  }
  const systemText = systemParts.join("\n\n");
  if (systemText) {
    return `System instructions:\n${systemText}\n\nUser: ${userContent}`;
  }
  return userContent;
}
```

- [ ] **Step 4: Implement SSE delta parser**

```typescript
export function parseQwenSSEDelta(
  line: string,
): QwenDelta | null {
  if (!line.startsWith("data:")) return null;
  const payload = line.slice(5).trim();
  if (!payload || payload === "[DONE]") return null;
  let parsed: {
    choices?: Array<{ delta?: { phase?: string | null; content?: unknown } }>;
  };
  try {
    parsed = JSON.parse(payload);
  } catch {
    return null;
  }
  const delta = parsed?.choices?.[0]?.delta;
  if (!delta) return null;
  const phase = delta.phase;
  const content = typeof delta.content === "string" ? delta.content : "";
  if (!content) return null;
  if (phase === "think" || phase === "thinking_summary") {
    return { kind: "think", text: content };
  }
  if (phase === "answer" || phase === null || phase === undefined) {
    return { kind: "answer", text: content };
  }
  return null;
}
```

- [ ] **Step 5: Implement chat creation**

```typescript
export async function createQwenChat(
  modelId: string = "qwen3.7-plus",
): Promise<string> {
  const resp = await fetch(`${BASE_URL}/api/v2/chats/new`, {
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
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`Qwen create-chat failed (${resp.status}): ${text.slice(0, 200)}`);
  }
  const body = await resp.json();
  const chatId: string | undefined = body?.data?.id;
  if (!chatId) throw new Error("Qwen create-chat returned no chat id");
  return chatId;
}
```

- [ ] **Step 6: Implement message sending + SSE parsing**

```typescript
export async function sendQwenMessage(
  chatId: string,
  modelId: string,
  prompt: string,
): Promise<{ content: string; reasoning: string }> {
  const fid = uuid();
  const url = `${BASE_URL}/api/v2/chat/completions?chat_id=${chatId}`;
  const body = JSON.stringify({
    stream: true,
    incremental_output: true,
    chat_id: chatId,
    chat_mode: "normal",
    model: modelId,
    parent_id: null,
    messages: [
      {
        fid,
        parentId: null,
        childrenIds: [],
        role: "user",
        content: prompt,
        user_action: "chat",
        files: [],
        timestamp: Math.floor(Date.now() / 1000),
        models: [modelId],
        chat_type: "t2t",
        feature_config: {
          thinking_enabled: true,
          output_schema: "phase",
          auto_thinking: true,
          research_mode: "normal",
          auto_search: false,
        },
        sub_chat_type: "t2t",
        parent_id: null,
      },
    ],
  });

  const resp = await fetch(url, {
    method: "POST",
    credentials: "include",
    headers: getQwenHeaders(),
    body,
  });

  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`Qwen completion failed (${resp.status}): ${text.slice(0, 200)}`);
  }

  const reader = resp.body?.getReader();
  if (!reader) throw new Error("Qwen response has no body stream");
  const decoder = new TextDecoder();
  let buffer = "";
  let content = "";
  let reasoning = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";
    for (const line of lines) {
      const delta = parseQwenSSEDelta(line);
      if (!delta) continue;
      if (delta.kind === "think") {
        reasoning += delta.text;
      } else if (delta.kind === "answer") {
        content += delta.text;
      }
    }
  }

  return { content, reasoning };
}
```

- [ ] **Step 7: Build to verify no errors**

```bash
cd browser-extension && npm run build
```
Expected: Build succeeds, `qwen_api.ts` is bundled into the output.

- [ ] **Step 8: Commit**

```bash
git add browser-extension/src/lib/qwen_api.ts
git commit -m "feat(qwen-api): add direct API client for Qwen v2 chat endpoints"
```

---
### Task 2: Update Content Script Execute Handler

**Files:**
- Modify: `browser-extension/src/content_script.ts` (execute handler + imports)

**Interfaces:**
- Consumes: `createQwenChat()`, `sendQwenMessage()`, `foldMessages()` from `qwen_api.ts`
- Produces: updated execute handler that tries API first, falls back to DOM + polling

- [ ] **Step 1: Add import at top of content_script.ts**

```typescript
import {
  createQwenChat,
  sendQwenMessage,
  foldMessages,
} from "./lib/qwen_api";
```

- [ ] **Step 2: Rewrite the execute handler to try API first**

Replace the current try block inside `bridge.onMessage(async (msg: any) => { if (msg.type === "execute") { ... } })` with:

```typescript
      try {
        // ── Phase 1: Try direct Qwen API ──
        const modelId = "qwen3.7-plus";
        const prompt = foldMessages(msg.messages);

        console.debug("[ContentScript] Creating Qwen chat via API...");
        const chatId = await createQwenChat(modelId);
        console.debug("[ContentScript] Chat created:", chatId);

        console.debug("[ContentScript] Sending message via API...");
        // Lock pendingRequest as isPolling=false (API handles delivery directly)
        if (pendingRequest) pendingRequest.isPolling = false;

        const { content, reasoning } = await sendQwenMessage(
          chatId,
          modelId,
          prompt,
        );
        console.debug("[ContentScript] API response received, content length:", content.length);

        // Send reasoning first if present
        if (reasoning && pendingRequest?.id === msg.id) {
          bridge.send({ type: "reasoning", id: msg.id, content: reasoning });
        }
        // Send answer content
        if (content && pendingRequest?.id === msg.id) {
          bridge.send({
            type: "chunk",
            id: msg.id,
            data: { content, done: false },
          });
        }
        // Signal done
        if (pendingRequest?.id === msg.id) {
          bridge.send({
            type: "done",
            id: msg.id,
            usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
          });
          pendingRequest = null;
        }
        return; // Success — skip DOM fallback
      } catch (apiErr: any) {
        console.warn("[ContentScript] Direct API failed, falling back to DOM:", apiErr.message);

        // ── Fallback: DOM automation + polling (existing code) ──
        try {
          console.debug("[ContentScript] Requesting MAIN-world DOM via service worker...");
          const domResult: any = await chrome.runtime.sendMessage({
            type: "executeDom",
            text: lastUserMessage.content,
            requestId: msg.id,
          });

          let chatId: string | undefined;
          if (!domResult?.success) {
            console.warn("[ContentScript] MAIN-world DOM failed:", domResult?.error);
            const found = await findInputElement();
            if (!found) throw new Error("Could not find Qwen input element");
            const inputEl = found.el;
            if (!fillInput(inputEl, lastUserMessage.content)) throw new Error("fillInput failed");
            await delay(2000);
            clickSend(inputEl);
          } else {
            console.debug("[ContentScript] MAIN-world DOM done, chatId:", domResult.chatId);
            chatId = domResult.chatId;
          }

          if (chatId) {
            if (pendingRequest) pendingRequest.isPolling = true;
            pollChatForResponse(msg.id, bridge, chatId).catch((err: any) => {
              console.error("[ContentScript] Poll error:", err?.message);
            });
          } else {
            console.warn("[ContentScript] No chatId, enabling SSE fallback");
            if (pendingRequest) pendingRequest.isPolling = false;
          }
        } catch (domErr: any) {
          console.error("[ContentScript] DOM fallback also failed:", domErr);
          throw domErr; // Will be caught by outer catch
        }
      }
```

- [ ] **Step 3: Build to verify**

```bash
cd browser-extension && npm run build
```
Expected: Build succeeds with no errors.

- [ ] **Step 4: Commit**

```bash
git add browser-extension/src/content_script.ts
git commit -m "feat(content-script): use direct Qwen API as primary path, DOM as fallback"
```

---
### Task 3: Remove Deprecated Code (cleanup)

**Files:**
- Modify: `browser-extension/src/service_worker.ts`

- [ ] **Step 1: Remove `executeDomInMainWorld` from service worker**

The function `executeDomInMainWorld` is no longer called in the default path. Keep it for now (export if needed) but add a deprecation comment:

```typescript
// @deprecated Only used as DOM fallback when direct API call fails.
// Will be removed in a future version.
async function executeDomInMainWorld(...
```

- [ ] **Step 2: Build to verify**

```bash
cd browser-extension && npm run build
```

- [ ] **Step 3: Commit**

```bash
git add browser-extension/src/service_worker.ts
git commit -m "chore: deprecate executeDomInMainWorld"
```
