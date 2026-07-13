import {
  type QwenFile,
  type UploadedFileInfo,
  createQwenChat,
  sendQwenMessage,
  processOpenAIMessages,
  uploadAllImages,
} from "./lib/qwen_api";
import {
  injectToolDefinitions,
  parseToolCalls,
  stripToolCalls,
} from "./lib/tool_calling";
import {
  type ProxyConfig,
  DEFAULT_CONFIG,
  type ConnectionStatus,
} from "./lib/types";
import { WsBridge } from "./lib/ws_bridge";

// ── Page Script Injection ──
// CSP blocks inline <script>, so we request injection via service worker + chrome.scripting.executeScript({world: "MAIN"})
chrome.runtime.sendMessage({ type: "injectPageScript" }, () => {
  const err = chrome.runtime.lastError;
  if (err) console.warn("[QwenProxy] Inject request error:", err.message);
});

// ── Debug: log ALL window messages ────────────────
window.addEventListener("message", (event: MessageEvent) => {
  const src = event.data?.source;
  if (src === "__qwen_proxy" || src === "__qwen_proxy_response") {
    // already handled by dedicated handlers below
  } else if (src) {
    console.debug("[ContentProxy:MSG] Other message source:", src);
  }
});

// Session state is now managed by the proxy via chat_context in execute/done messages.

let abortController: AbortController | null = null;

// ── Thinking Mode ──────────────────────────────────────
let thinkingEnabled = true;
let searchEnabled = false;

/**
 * Fetch the last assistant message ID from an existing chat.
 * Used by /change to set parentId for multi-turn continuity (via chat_context).
 * Throws if the chat doesn't exist (HTTP error).
 */
async function fetchLastAssistantId(chatId: string): Promise<string | null> {
  const resp = await fetch(`https://chat.qwen.ai/api/v2/chats/${chatId}`, { credentials: "include" });
  if (!resp.ok) throw new Error(`Chat not found (${resp.status})`);
  const body = await resp.json();
  const chat = body?.data?.chat || body?.chat;
  if (!chat?.history?.messages) return null;
  const msgArray: any[] = Array.isArray(chat.history.messages)
    ? chat.history.messages : Object.values(chat.history.messages);
  const assistantMsgs = msgArray.filter((m: any) => m.role === "assistant");
  if (assistantMsgs.length === 0) return null;
  return assistantMsgs[assistantMsgs.length - 1].id || null;
}

// ── SSE State ─────────────────────────────────────────
let pendingRequest: {
  id: string;
  bridge: WsBridge;
  sseBuffer: string;
  thinkingContent: string;
  thinkingFinished: boolean;
  hasSentThinking: boolean;
  hasSentAnswer: boolean;
  /** If true, polling is the primary delivery path; SSE data is buffered for debug only */
  isPolling: boolean;
} | null = null;

// Listen for SSE data from page fetch interception (via postMessage)
window.addEventListener("message", (event: MessageEvent) => {
  if (event.data?.source !== "__qwen_proxy") return;
  if (!pendingRequest) {
    console.warn("[QwenProxy] Received SSE data but no pending request");
    return;
  }

  if (event.data.type === "end") {
    // Let handleCompletedResponse decide whether to clear pendingRequest.
    // If SSE delivered real data, it clears pendingRequest.
    // If SSE failed (no data), pendingRequest stays alive for polling fallback.
    handleCompletedResponse(pendingRequest);
    return;
  }

  if (event.data.type === "chunk") {
    pendingRequest.sseBuffer += event.data.text;
    processSSEBuffer(pendingRequest);
  }
});

function processSSEBuffer(state: typeof pendingRequest): void {
  if (!state) return;
  const lines = state.sseBuffer.split("\n");
  state.sseBuffer = lines.pop() || "";

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith(":")) continue; // comment/empty lines
    if (!trimmed.startsWith("data: ")) {
      // SSE event line (event: ...), skip
      continue;
    }
    const raw = trimmed.slice(6);
    if (raw === "[DONE]") continue;

    let event: any;
    try {
      event = JSON.parse(raw);
    } catch {
      console.debug("[SSE] Unparseable JSON:", raw.slice(0, 100));
      continue;
    }

    // Debug: log event keys to understand Qwen SSE format
    const keys = Object.keys(event);
    if (keys.length > 0 && keys[0] !== "choices") {
      console.debug("[SSE] Non-standard event keys:", keys.join(","), "id:" + (event.id || "?").slice(0, 12));
    }

    if (event["response.created"]) continue;

    // If polling is active, just buffer for debug — don't send or update state
    if (state.isPolling) {
      console.debug("[SSE] Polling active, skipping SSE delivery, event keys:", keys.join(","));
      continue;
    }

    const choice = event?.choices?.[0];
    if (!choice?.delta) continue;

    const delta = choice.delta;
    const phase = delta.phase;

    if (phase === "thinking_summary") {
      if (delta.extra?.summary_thought?.content) {
        const thoughts = delta.extra.summary_thought.content;
        state.thinkingContent += Array.isArray(thoughts)
          ? thoughts.join("\n")
          : String(thoughts);
      }
      if (delta.status === "finished") {
        state.thinkingFinished = true;
      }
    } else if (phase === "answer") {
      state.hasSentAnswer = true;
      if (state.thinkingFinished && !state.hasSentThinking && state.thinkingContent) {
        state.bridge.send({
          type: "reasoning",
          id: state.id,
          content: state.thinkingContent,
        });
        state.hasSentThinking = true;
      }
      const content = delta.content || "";
      if (content) {
        state.bridge.send({
          type: "chunk",
          id: state.id,
          data: { content, done: false },
        });
      }
      if (delta.status === "finished") {
        finishRequest(state, event.usage);
        pendingRequest = null;
      }
    }
  }
}

function handleCompletedResponse(state: NonNullable<typeof pendingRequest>): void {
  // When polling is active, SSE end doesn't mean the response is ready — polling handles delivery.
  // Don't send anything or clear pendingRequest; let polling or the overall timeout handle it.
  if (state.isPolling) {
    console.debug("[SSE] Polling active, ignoring SSE stream end");
    return;
  }

  if (state.hasSentAnswer) {
    if (!state.hasSentThinking && state.thinkingContent) {
      state.bridge.send({ type: "reasoning", id: state.id, content: state.thinkingContent });
    }
    state.bridge.send({
      type: "done",
      id: state.id,
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    });
    pendingRequest = null;
  } else if (state.thinkingContent) {
    state.bridge.send({ type: "reasoning", id: state.id, content: state.thinkingContent });
    state.bridge.send({
      type: "done",
      id: state.id,
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    });
    pendingRequest = null;
  }
  // else: No real data from SSE — keep pendingRequest alive for polling fallback
}

function finishRequest(
  state: NonNullable<typeof pendingRequest>,
  usage: any,
): void {
  if (!state.hasSentThinking && state.thinkingContent) {
    state.bridge.send({
      type: "reasoning",
      id: state.id,
      content: state.thinkingContent,
    });
  }
  state.bridge.send({
    type: "done",
    id: state.id,
    usage: {
      prompt_tokens: usage?.input_tokens || 0,
      completion_tokens: usage?.output_tokens || 0,
      total_tokens: usage?.total_tokens || 0,
    },
  });
}

// ── DOM Automation ────────────────────────────────────
async function findInputElement(maxWait = 10000): Promise<{ el: HTMLElement; selector: string } | null> {
  const start = Date.now();
  while (Date.now() - start < maxWait) {
    const ta = document.querySelector<HTMLElement>("textarea.message-input-textarea");
    if (ta) return { el: ta, selector: "textarea.message-input-textarea" };
    const any = document.querySelector<HTMLElement>(
      "textarea:not([disabled]):not([readonly]), [contenteditable='true']",
    );
    if (any) {
      const tag = any.tagName.toLowerCase();
      const sel = tag === "textarea" ? "textarea fallback" : "contenteditable fallback";
      return { el: any, selector: sel };
    }
    await delay(300);
  }
  return null;
}

function fillInput(el: HTMLElement, text: string): boolean {
  const tag = el.tagName.toLowerCase();
  console.debug("[QwenProxy] fillInput target:", tag, "class:", el.className?.slice(0, 80));
  el.focus();

  if (tag === "textarea" || tag === "input") {
    const inputEl = el as HTMLTextAreaElement;

    // Log React state before
    console.debug("[QwenProxy] fillInput: value before set =", JSON.stringify(inputEl.value).slice(0, 100));

    // ── Strategy 1: Clear then set (triggers React change detection) ──
    const nativeSetter = Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype, "value",
    )?.set;
    if (nativeSetter) {
      // Clear first
      nativeSetter.call(inputEl, "");
      inputEl.dispatchEvent(new Event("input", { bubbles: true, composed: true }));

      // Then set actual text
      nativeSetter.call(inputEl, text);
    } else {
      inputEl.value = "";
      inputEl.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
      inputEl.value = text;
    }

    // Dispatch InputEvent with full properties (most native-like)
    inputEl.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
    inputEl.dispatchEvent(new Event("change", { bubbles: true }));

    // InputEvent with insertText — the most realistic user-typing event
    try {
      inputEl.dispatchEvent(new InputEvent("beforeinput", {
        bubbles: true,
        cancelable: true,
        inputType: "insertText",
        data: text,
      }));
    } catch { /* ok */ }
    try {
      inputEl.dispatchEvent(new InputEvent("input", {
        bubbles: true,
        cancelable: true,
        inputType: "insertText",
        data: text,
      }));
    } catch { /* ok */ }

    console.debug("[QwenProxy] fillInput: value after set =", JSON.stringify(inputEl.value).slice(0, 100), "| length:", text.length);
    return true;
  } else if (el.getAttribute("contenteditable") === "true") {
    el.textContent = text;
    el.dispatchEvent(new Event("input", { bubbles: true }));
    return true;
  }
  return false;
}

function clickSend(inputEl: HTMLElement): void {
  const tag = inputEl.tagName.toLowerCase();
  console.debug("[QwenProxy] clickSend on", tag);

  if (tag === "textarea" || tag === "input") {
    // Log value right before Enter
    const textarea = inputEl as HTMLTextAreaElement;
    console.debug("[QwenProxy] clickSend: textarea value length =", textarea.value?.length);
    if (textarea.value?.length === 0) {
      console.warn("[QwenProxy] clickSend: textarea value is EMPTY — React state likely not updated!");
    }

    // Dispatch native keydown with all realistic properties
    const enterEvent = new KeyboardEvent("keydown", {
      key: "Enter",
      code: "Enter",
      keyCode: 13,
      which: 13,
      bubbles: true,
      cancelable: true,
      composed: true,
    });
    inputEl.dispatchEvent(enterEvent);

    inputEl.dispatchEvent(
      new KeyboardEvent("keypress", {
        key: "Enter",
        code: "Enter",
        keyCode: 13,
        which: 13,
        bubbles: true,
        cancelable: true,
      }),
    );

    inputEl.dispatchEvent(
      new KeyboardEvent("keyup", {
        key: "Enter",
        code: "Enter",
        keyCode: 13,
        which: 13,
        bubbles: true,
        cancelable: true,
      }),
    );

    console.debug("[QwenProxy] Dispatched Enter key sequence on input element");
    return;
  }

  // Fallback: look for a send button
  const btn =
    document.querySelector<HTMLButtonElement>("button.send-button:not([disabled])") ||
    document.querySelector<HTMLButtonElement>(
      'button[aria-label*="send"], button[aria-label*="发送"], button[aria-label*="submit"]',
    );
  if (btn) {
    btn.click();
    console.debug("[QwenProxy] Clicked send button");
  }
}

function simulateUserType(el: HTMLElement, text: string): boolean {
  // Strategy 2: Simulate character-by-character input for deeply nested React listeners
  try {
    el.focus();
    const tag = el.tagName.toLowerCase();

    if (tag !== "textarea" && tag !== "input") return false;
    const inputEl = el as HTMLTextAreaElement;

    // First focus then execCommand (deprecated but works on modern Chrome)
    el.focus();
    const success = document.execCommand("insertText", false, text);
    if (success) {
      console.debug("[QwenProxy] execCommand insertText succeeded, length:", text.length);
      return true;
    }
    return false;
  } catch (e) {
    console.debug("[QwenProxy] execCommand failed:", e);
    return false;
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ── Polling (content-script world, replaces MAIN-world postMessage) ──
async function pollChatForResponse(
  requestId: string,
  bridge: WsBridge,
  chatId: string,
): Promise<void> {
  console.debug("[Poll] Starting poll for chatId:", chatId, "requestId:", requestId);

  // Establish baseline: record the last assistant message ID (if any) and whether it had a done flag.
  // The response may already exist (Qwen is fast), or may still be generating.
  // We detect either case: new message OR same message whose state progressed.
  let baselineId: string | undefined;
  let baselineDone = false;
  let baselineHasContent = false;
  try {
    const br = await fetch(`https://chat.qwen.ai/api/v2/chats/${chatId}`, { credentials: "include" });
    if (br.ok) {
      const bb = await br.json();
      const bc = bb?.data?.chat || bb?.chat;
      if (bc?.history?.messages) {
        const bm: any[] = Array.isArray(bc.history.messages) ? bc.history.messages : Object.values(bc.history.messages);
        const am = bm.filter((m: any) => m.role === "assistant");
        if (am.length > 0) {
          const last = am[am.length - 1];
          baselineId = last.id;
          baselineDone = !!(last.done === true || last.status === "done" || last.status === "finished");
          baselineHasContent = !!(last.content_list && Array.isArray(last.content_list) && last.content_list.length > 0);
        }
      }
    }
    console.debug("[Poll] Baseline id:", baselineId?.slice(0, 12), "done:", baselineDone, "hasContent:", baselineHasContent);
  } catch {
    console.debug("[Poll] Baseline fetch failed");
  }

  const maxAttempts = 75;
  let attempts = 0;
  let sentThinking = false;
  let sentAnswer = false;
  let lastSentLength = 0;
  let lastThinkingLength = 0;

  while (attempts < maxAttempts) {
    attempts++;

    if (!pendingRequest || pendingRequest.id !== requestId) {
      console.debug("[Poll] pendingRequest cleared, stopping poll");
      return;
    }

    try {
      const resp = await fetch(`https://chat.qwen.ai/api/v2/chats/${chatId}`, { credentials: "include" });
      if (!resp.ok) {
        console.debug(`[Poll] HTTP ${resp.status}, retry ${attempts}/${maxAttempts}`);
        await delay(2000);
        continue;
      }

      const body = await resp.json();
      const chat = body?.data?.chat || body?.chat;
      if (!chat?.history?.messages) {
        await delay(2000);
        continue;
      }

      const msgArray: any[] = Array.isArray(chat.history.messages)
        ? chat.history.messages : Object.values(chat.history.messages);
      const assistantMsgs = msgArray.filter((m: any) => m.role === "assistant");
      if (assistantMsgs.length === 0) {
        await delay(2000);
        continue;
      }

      const lastAssistant = assistantMsgs[assistantMsgs.length - 1];
      const isNew = lastAssistant.id !== baselineId;
      const isDone = lastAssistant.done === true
        || lastAssistant.status === "done"
        || lastAssistant.status === "finished";
      const hasContent = !!(lastAssistant.content_list && Array.isArray(lastAssistant.content_list) && lastAssistant.content_list.length > 0);

      // Accept if: new message appeared, OR same message progressed
      if (!isNew && !isDone && hasContent === baselineHasContent) {
        // No change yet — keep waiting
        await delay(2000);
        continue;
      }

      // Wait for content_list to appear if it hasn't yet
      if (!hasContent) {
        await delay(2000);
        continue;
      }

      const contentList = lastAssistant.content_list;
      const thinkingEntry = contentList.find((c: any) => c.phase === "thinking_summary");
      let thinkingContent = "";
      if (thinkingEntry?.extra?.summary_thought?.content) {
        const thoughts = thinkingEntry.extra.summary_thought.content;
        thinkingContent = Array.isArray(thoughts) ? thoughts.join("\n") : String(thoughts);
      }

      const answerEntry = contentList.find((c: any) => c.phase === "answer");
      const answerContent = answerEntry?.content || "";

      if (thinkingContent) {
        const newThinking = thinkingContent.slice(lastThinkingLength);
        if (newThinking) {
          bridge.send({ type: "reasoning", id: requestId, content: newThinking });
        }
        lastThinkingLength = thinkingContent.length;
        sentThinking = true;
      }

      if (answerContent) {
        const newContent = answerContent.slice(lastSentLength);
        if (newContent) {
          bridge.send({ type: "chunk", id: requestId, data: { content: newContent, done: false } });
        }
        lastSentLength = answerContent.length;
        sentAnswer = true;
      }

      if (isDone) {
        console.debug("[Poll] Response complete");
        if (thinkingContent) {
          const remainingThinking = thinkingContent.slice(lastThinkingLength);
          if (remainingThinking) {
            bridge.send({ type: "reasoning", id: requestId, content: remainingThinking });
          }
        }
        if (answerContent) {
          const remainingAnswer = answerContent.slice(lastSentLength);
          if (remainingAnswer) {
            bridge.send({ type: "chunk", id: requestId, data: { content: remainingAnswer, done: false } });
          }
        }
        bridge.send({
          type: "done",
          id: requestId,
          usage: {
            prompt_tokens: lastAssistant.usage?.input_tokens || 0,
            completion_tokens: lastAssistant.usage?.output_tokens || 0,
            total_tokens: (lastAssistant.usage?.input_tokens || 0) + (lastAssistant.usage?.output_tokens || 0),
          },
        });
        pendingRequest = null;
        return;
      }
    } catch (err: any) {
      console.debug("[Poll] Fetch error:", err?.message);
    }

    await delay(2000);
  }

  console.warn("[Poll] Max attempts reached, timing out");
  if (pendingRequest?.id === requestId) {
    bridge.send({ type: "error", id: requestId, error: { message: "Poll timed out" } });
    pendingRequest = null;
  }
}

// ── Main ──────────────────────────────────────────────
console.log("[QwenProxy] Content script loaded (hybrid mode)");

async function main(): Promise<void> {
  console.log("[ContentScript] main() called (stateless mode — chat context from proxy)");
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

  // Discover the actual API key from the proxy before connecting WS.
  // Route through the service worker to avoid CORS issues (HTTPS page → HTTP proxy).
  let actualKey = config.apiKey;
  try {
    const resp = await chrome.runtime.sendMessage({ type: "discoverApiKey" });
    if (resp?.apiKey && resp.apiKey !== config.apiKey) {
      console.log("[QwenProxy] Proxy has different API key, syncing");
      actualKey = resp.apiKey;
      chrome.storage.sync.set({ apiKey: actualKey });
    }
  } catch {
    console.warn("[QwenProxy] Could not discover API key from proxy, using stored key");
  }

  console.log("[QwenProxy] Connecting WS to", config.proxyHost + ":" + config.proxyPort);
  const bridge = new WsBridge(config.proxyHost, config.proxyPort, actualKey);
  bridge.onStatusChange((status) => {
    console.debug("[QwenProxy] WS status:", status);
  });
  bridge.connect();

  // ── Listen for polled responses from MAIN world ──
  // After DOM automation, the MAIN world script polls GET /api/v2/chats/<chatId>
  // and posts results via window.postMessage with source "__qwen_proxy_response"
  window.addEventListener("message", (event: MessageEvent) => {
    if (event.data?.source !== "__qwen_proxy_response") return;
    const pd = event.data;
    if (!pendingRequest || pendingRequest.id !== pd.requestId) {
      console.debug("[ContentScript] Poll result for unknown request:", pd.requestId);
      return;
    }

    if (pd.type === "completed") {
      console.debug("[ContentScript] Polled response received, content length:", pd.content?.length);

      // Send reasoning first if exists
      if (pd.reasoning) {
        bridge.send({ type: "reasoning", id: pendingRequest.id, content: pd.reasoning });
      }
      // Send content as single completion
      if (pd.content) {
        bridge.send({
          type: "chunk",
          id: pendingRequest.id,
          data: { content: pd.content, done: false },
        });
      }
      // Signal done
      bridge.send({
        type: "done",
        id: pendingRequest.id,
        usage: {
          prompt_tokens: pd.usage?.input_tokens || 0,
          completion_tokens: pd.usage?.output_tokens || 0,
          total_tokens: (pd.usage?.input_tokens || 0) + (pd.usage?.output_tokens || 0),
        },
      });
      pendingRequest = null;
      return;
    }

    if (pd.type === "error" || pd.type === "timeout") {
      console.warn("[ContentScript] Poll error:", pd.error);
      bridge.send({
        type: "error",
        id: pendingRequest.id,
        error: { message: pd.error || "Poll failed" },
      });
      pendingRequest = null;
    }
  });

  bridge.onMessage(async (msg: any) => {
    if (msg.type === "execute") {
      // Read chat context from proxy-managed session state
      const ctx = msg.chat_context || {};
      let chatId: string | null = ctx.chatId || null;
      let parentId: string | null = ctx.parentId || null;
      let systemPrompt: string | null = ctx.systemPrompt || null;

      console.log("[ContentScript] ▶ execute id:", msg.id, "chatId:", chatId, "parentId:", parentId, "pending:", !!pendingRequest);
      console.log("[ContentScript]   messages count:", msg.messages?.length, "roles:", msg.messages?.map((m: any) => m.role));

      if (pendingRequest) {
        console.warn("[ContentScript] ⚠ pendingRequest already exists, rejecting new execute id:", msg.id, "existing:", pendingRequest.id);
        if (abortController) abortController.abort();
        abortController = null;
        bridge.send({
          type: "error",
          id: pendingRequest.id,
          error: { message: "Replaced by new request" },
        });
        pendingRequest = null;
        bridge.send({
          type: "error",
          id: msg.id,
          error: { message: "Previous request still in progress" },
        });
        return;
      }

      const lastUserMessage = msg.messages
        ?.filter((m: any) => m.role === "user")
        .pop();

      const contentText = (c: any): string => {
        if (typeof c === "string") return c;
        if (Array.isArray(c)) {
          return c.filter((p: any) => p.type === "text").map((p: any) => p.text).join(" ");
        }
        return String(c);
      };

      // ── Handle system-only requests (Cherry Studio split-request pattern) ──
      // Proxy caches system prompt in chat_context.systemPrompt; we return updated context.
      const hasUserContent = lastUserMessage && (
        typeof lastUserMessage.content === "string"
          ? lastUserMessage.content.trim().length > 0
          : Array.isArray(lastUserMessage.content) && lastUserMessage.content.length > 0
      );
      if (!hasUserContent) {
        const systemMessages = msg.messages?.filter((m: any) => m.role === "system");
        if (systemMessages && systemMessages.length > 0) {
          const systemContent = systemMessages.map((m: any) => contentText(m.content)).filter(Boolean).join("\n\n");
          if (systemContent.trim()) {
            systemPrompt = systemContent;
            console.debug("[ContentScript] Cached system prompt, len:", systemContent.length);
            bridge.send({
              type: "chunk", id: msg.id,
              data: { content: "System prompt cached.", done: false },
            });
            bridge.send({
              type: "done", id: msg.id,
              usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
              chat_context: { chatId, parentId, systemPrompt },
            });
            return;
          }
        }
        console.debug("[ContentScript] Rejecting execute: no user message content");
        bridge.send({
          type: "error",
          id: msg.id,
          error: { message: "No user message content" },
        });
        return;
      }

      const userText = contentText(lastUserMessage.content).trim();

      // ── Command: /help — show available commands ──
      if (userText === "/help") {
        const helpText = [
          "**Available commands:**",
          "",
          "`/new` — Create a new chat session",
          "`/change <chat_id>` — Switch to existing chat",
          "`/viewid` — Show current chat ID",
          "`/viewchats` — List all chat sessions with timestamps",
          "`/enable-thinking` — Enable thinking mode",
          "`/disable-thinking` — Disable thinking mode",
          "`/enable-search` — Enable web search",
          "`/disable-search` — Disable web search",
          "`/genimage <prompt>` — Generate image (t2i mode)",
          "`/genppt <prompt>` — Generate presentation (slides + PDF)",
          "`/deletechat <chat_id>` — Delete a chat session",
          "`/help` — Show this help message",
        ].join("\n");
        bridge.send({
          type: "chunk", id: msg.id,
          data: { content: helpText, done: false },
        });
        bridge.send({
          type: "done", id: msg.id,
          usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
          chat_context: { chatId, parentId, systemPrompt },
        });
        return;
      }

      // ── Command: /new — create a new chat session ──
      if (userText === "/new") {
        console.log("[ContentScript] /new command received");
        try {
          const newChatId = await createQwenChat();
          chatId = newChatId;
          parentId = null;
          systemPrompt = null;
          console.log("[ContentScript] /new → chatId:", chatId);
          bridge.send({
            type: "chunk", id: msg.id,
            data: { content: `New chat created: \`${chatId}\``, done: false },
          });
          bridge.send({
            type: "done", id: msg.id,
            usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
            chat_context: { chatId, parentId: null, systemPrompt: null },
          });
        } catch (err: any) {
          bridge.send({ type: "error", id: msg.id, error: { message: `Failed to create chat: ${err.message}` } });
        }
        return;
      }

      // ── Command: /change <chat_id> — switch to existing chat ──
      const changeMatch = userText.match(/^\/change\s+(\S+)/);
      if (changeMatch) {
        const newChatId = changeMatch[1];
        console.log("[ContentScript] /change command, newChatId:", newChatId);
        try {
          const lastId = await fetchLastAssistantId(newChatId);
          chatId = newChatId;
          parentId = lastId;
          systemPrompt = null;
          bridge.send({
            type: "chunk", id: msg.id,
            data: { content: `Switched to chat: \`${newChatId}\``, done: false },
          });
          bridge.send({
            type: "done", id: msg.id,
            usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
            chat_context: { chatId, parentId, systemPrompt: null },
          });
        } catch (err: any) {
          bridge.send({ type: "error", id: msg.id, error: { message: `Failed to switch chat: ${err.message}` } });
        }
        return;
      }

      // ── Command: /viewid — show current chat_id ──
      if (userText === "/viewid") {
        console.log("[ContentScript] /viewid → chatId:", chatId);
        const id = chatId || "No active chat session";
        bridge.send({
          type: "chunk", id: msg.id,
          data: { content: id, done: false },
        });
        bridge.send({
          type: "done", id: msg.id,
          usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
          chat_context: { chatId, parentId, systemPrompt },
        });
        return;
      }

      // ── Command: /viewchats — list all chat sessions ──
      if (userText === "/viewchats") {
        console.log("[ContentScript] /viewchats command");
        try {
          const items: { id: string; title: string; created: number; updated: number }[] = [];
          let page = 1;
          while (true) {
            const url = `https://chat.qwen.ai/api/v2/chats/?page=${page}&exclude_project=true`;
            const resp = await fetch(url, { credentials: "include" });
            if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
            const body = await resp.json();
            const data: any[] | null = body?.data;
            if (!data || data.length === 0) break;
            for (const chat of data) {
              if (chat.id && chat.title) {
                items.push({
                  id: chat.id,
                  title: chat.title,
                  created: chat.created_at,
                  updated: chat.updated_at,
                });
              }
            }
            page++;
          }

          const fmt = (ts: number) => {
            const d = new Date(ts * 1000);
            const pad = (n: number) => String(n).padStart(2, "0");
            return `${d.getFullYear()}/${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${pad(d.getHours())}/${pad(d.getMinutes())}/${pad(d.getSeconds())}`;
          };

          const lines = items.map((c) =>
            `**id:** ${c.id}<br>**title:** ${c.title}<br>**create time:** ${fmt(c.created)}<br>**last update time:** ${fmt(c.updated)}`
          ).join("\n\n---\n\n");

          bridge.send({
            type: "chunk", id: msg.id,
            data: { content: lines || "No chat sessions found.", done: false },
          });
          bridge.send({
            type: "done", id: msg.id,
            usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
            chat_context: { chatId, parentId, systemPrompt },
          });
        } catch (err: any) {
          bridge.send({ type: "error", id: msg.id, error: { message: `Failed to list chats: ${err.message}` } });
        }
        return;
      }

      // ── Command: /deletechat <chat_id> — delete a chat session ──
      const deleteMatch = userText.match(/^\/deletechat\s+(\S+)/);
      if (deleteMatch) {
        const targetId = deleteMatch[1];
        console.log("[ContentScript] /deletechat command, targetId:", targetId);
        try {
          const resp = await fetch(`https://chat.qwen.ai/api/v2/chats/${targetId}`, {
            method: "DELETE",
            credentials: "include",
            headers: { "Content-Type": "application/json" },
          });
          if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
          const body = await resp.json();
          const deleted = body?.data?.status === true;
          bridge.send({
            type: "chunk", id: msg.id,
            data: { content: deleted ? `Chat deleted: \`${targetId}\`` : `Delete failed for: \`${targetId}\``, done: false },
          });
          bridge.send({
            type: "done", id: msg.id,
            usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
            chat_context: { chatId, parentId, systemPrompt },
          });
        } catch (err: any) {
          bridge.send({ type: "error", id: msg.id, error: { message: `Delete chat failed: ${err.message}` } });
        }
        return;
      }

      // ── Command: /enable-thinking — enable thinking mode ──
      if (userText === "/enable-thinking") {
        thinkingEnabled = true;
        bridge.send({
          type: "chunk", id: msg.id,
          data: { content: "Thinking mode enabled (quick → thinking). Next message will use thinking mode.", done: false },
        });
        bridge.send({
          type: "done", id: msg.id,
          usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
          chat_context: { chatId, parentId, systemPrompt },
        });
        return;
      }

      // ── Command: /disable-thinking — disable thinking mode ──
      if (userText === "/disable-thinking") {
        thinkingEnabled = false;
        bridge.send({
          type: "chunk", id: msg.id,
          data: { content: "Thinking mode disabled (thinking → quick). Next message will use quick mode.", done: false },
        });
        bridge.send({
          type: "done", id: msg.id,
          usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
          chat_context: { chatId, parentId, systemPrompt },
        });
        return;
      }

      // ── Command: /enable-search — enable web search ──
      if (userText === "/enable-search") {
        searchEnabled = true;
        bridge.send({
          type: "chunk", id: msg.id,
          data: { content: "Auto search enabled. Next message will use web search.", done: false },
        });
        bridge.send({
          type: "done", id: msg.id,
          usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
          chat_context: { chatId, parentId, systemPrompt },
        });
        return;
      }

      // ── Command: /disable-search — disable web search ──
      if (userText === "/disable-search") {
        searchEnabled = false;
        bridge.send({
          type: "chunk", id: msg.id,
          data: { content: "Auto search disabled. Next message will not use web search.", done: false },
        });
        bridge.send({
          type: "done", id: msg.id,
          usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
          chat_context: { chatId, parentId, systemPrompt },
        });
        return;
      }

      // ── Command: /genimage <prompt> — generate image via t2i ──
      const genimageMatch = userText.match(/^\/genimage\s+(.+)/s);
      if (genimageMatch) {
        const imagePrompt = genimageMatch[1].trim();
        const t2iModel = msg.model || "qwen3.7-plus";
        console.log("[ContentScript] /genimage command, prompt:", imagePrompt.slice(0, 80), "model:", t2iModel);
        try {
          // Reuse current chat if available; the per-message chat_type/mode handle t2i
          if (!chatId) {
            chatId = await createQwenChat(t2iModel, "t2t");
            parentId = null;
          }
          const result = await sendQwenMessage(
            chatId, t2iModel, imagePrompt,
            parentId, undefined, false, false, [], "t2i",
          );
          const text = result.content || "Image generated.";
          bridge.send({
            type: "chunk", id: msg.id,
            data: { content: text, done: false },
          });
          bridge.send({
            type: "done", id: msg.id,
            usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
            chat_context: { chatId, parentId, systemPrompt },
          });
        } catch (err: any) {
          bridge.send({ type: "error", id: msg.id, error: { message: `Image generation failed: ${err.message}` } });
        }
        return;
      }

      // ── Command: /genppt <prompt> — generate presentation via slides mode ──
      const genpptMatch = userText.match(/^\/genppt\s+(.+)/s);
      if (genpptMatch) {
        const pptPrompt = genpptMatch[1].trim();
        const pptModel = msg.model || "qwen3.7-plus";
        console.log("[ContentScript] /genppt command, prompt:", pptPrompt.slice(0, 80), "model:", pptModel);
        try {
          if (!chatId) {
            chatId = await createQwenChat(pptModel, "slides");
            parentId = null;
          }
          // Phase 1: Send topic to Qwen — receives draft plan
          const result1 = await sendQwenMessage(
            chatId, pptModel, pptPrompt,
            null, undefined, true, true, [], "slides",
          );
          const draftPlan = result1.content || "";

          // Phase 2: Send "开始" to trigger actual slide generation
          const result2 = await sendQwenMessage(
            chatId, pptModel, "开始",
            result1.parentId, undefined, true, true, [], "slides",
          );

          let responseText = draftPlan;
          if (result2.content) {
            responseText += (responseText ? "\n\n---\n\n" : "") + result2.content;
          }

          // Append slide images and PDF link from structured slide data
          const sd = result2.slideData;
          if (sd) {
            if (sd.slide_pages && sd.slide_pages.length > 0) {
              responseText += "\n\n---\n\n### 幻灯片预览\n";
              for (const page of sd.slide_pages) {
                responseText += `\n![第 ${page.page} 页](${page.image_url})`;
              }
            }
            if (sd.pdf_url) {
              responseText += `\n\n📕 **[下载 PDF](${sd.pdf_url})**`;
            }
          }

          bridge.send({
            type: "chunk", id: msg.id,
            data: { content: responseText || "PPT generated.", done: false },
          });
          bridge.send({
            type: "done", id: msg.id,
            usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
            chat_context: { chatId, parentId, systemPrompt },
          });
        } catch (err: any) {
          bridge.send({ type: "error", id: msg.id, error: { message: `PPT generation failed: ${err.message}` } });
        }
        return;
      }

      // ── Normal message: use session-aware API ──
      console.log("[ContentScript] Normal message flow, userText:", userText.slice(0, 80));

      // Set up pending request (isPolling=true initially to prevent SSE from racing;
      // falls back to false below if no chatId available)
      if (abortController) abortController.abort();
      abortController = new AbortController();

      pendingRequest = {
        id: msg.id,
        bridge,
        sseBuffer: "",
        thinkingContent: "",
        thinkingFinished: false,
        hasSentThinking: false,
        hasSentAnswer: false,
        isPolling: true,
      };

      try {
        // ── Phase 1: Try direct Qwen API ──
        try {
          // Inject tool definitions if present
          if (msg.tools && Array.isArray(msg.tools) && msg.tools.length > 0) {
            console.debug("[ContentScript] Injecting", msg.tools.length, "tool definitions");
            msg.messages = injectToolDefinitions(msg.messages, msg.tools);
          }

          const { text: prompt, files: rawFiles } = processOpenAIMessages(msg.messages, systemPrompt);
          systemPrompt = null; // consumed, clear for next split request
          const model = msg.model || "qwen3.7-plus";
          console.debug("[ContentScript] Processed prompt (%d chars, %d raw files) model=%s", prompt.length, rawFiles.length, model);

          let uploadedFiles: UploadedFileInfo[] = [];
          if (rawFiles.length > 0) {
            console.log("[ContentScript] Uploading %d images via STS/OSS...", rawFiles.length);
            uploadedFiles = await uploadAllImages(rawFiles, abortController?.signal);
            console.log("[ContentScript] Uploaded %d images", uploadedFiles.length);
          }

          // Auto-create a chat session on first message, reuse thereafter
          if (!chatId) {
            console.log("[ContentScript] chatId is null, calling createQwenChat(model=%s)...", model);
            chatId = await createQwenChat(model);
            console.log("[ContentScript] createQwenChat() returned:", chatId);
            parentId = null;
          }

          console.debug("[ContentScript] Using chat:", chatId, "parentId:", parentId, "model:", model);
          if (pendingRequest) pendingRequest.isPolling = false;

          const { content, reasoning, parentId: newParentId } = await sendQwenMessage(
            chatId,
            model,
            prompt,
            parentId,
            abortController?.signal,
            thinkingEnabled,
            searchEnabled,
            uploadedFiles,
          );

          // Update parentId for multi-turn continuity
          parentId = newParentId;

          console.debug("[ContentScript] API response received, content length:", content.length);

          // Check for tool calls in the response
          const toolCalls = parseToolCalls(content);
          let cleanContent = stripToolCalls(content);

          // Fallback: if websearch stripped everything, use reasoning as content
          if (!cleanContent && reasoning) {
            cleanContent = reasoning;
          }

          if (reasoning && pendingRequest?.id === msg.id) {
            bridge.send({ type: "reasoning", id: msg.id, content: reasoning });
          }
          if (cleanContent && pendingRequest?.id === msg.id) {
            bridge.send({
              type: "chunk",
              id: msg.id,
              data: { content: cleanContent, done: false },
            });
          }
          if (toolCalls && pendingRequest?.id === msg.id) {
            bridge.send({
              type: "tool_calls",
              id: msg.id,
              tool_calls: toolCalls,
            });
          }
          if (pendingRequest?.id === msg.id) {
            bridge.send({
              type: "done",
              id: msg.id,
              usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
              chat_context: { chatId, parentId, systemPrompt },
            });
            console.log("[ContentScript] ✓ execute completed, chatId:", chatId, "parentId:", parentId);
            pendingRequest = null;
            abortController = null;
          }
          return;
        } catch (apiErr: any) {
          console.error("[ContentScript] Direct API failed:", apiErr.message, "chatId:", chatId);
        }

        // ── Phase 2: Fallback — DOM automation + polling ──
        console.debug("[ContentScript] Requesting MAIN-world DOM via service worker...");

        const domResult: any = await chrome.runtime.sendMessage({
          type: "executeDom",
          text: lastUserMessage.content,
          requestId: msg.id,
        });

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
      } catch (err: any) {
        console.error("[ContentScript] Error in execute handler:", err);
        pendingRequest = null;
        abortController = null;
        bridge.send({
          type: "error",
          id: msg.id,
          error: { message: err.message || "Unknown error in execute handler" },
        });
        return;
      }

      // Overall timeout: 150s
      setTimeout(() => {
        if (pendingRequest?.id === msg.id) {
          console.warn("[ContentScript] Request timed out (no response)");
          bridge.send({
            type: "error",
            id: msg.id,
            error: { message: "Request timed out waiting for Qwen response" },
          });
          pendingRequest = null;
          abortController = null;
        }
      }, 150000);
    }
  });

  chrome.runtime.onMessage.addListener((message: any) => {
    if (message.type === "configUpdated") {
      console.log("[ContentScript] configUpdated received (stateless mode)");
      chrome.storage.sync.get(["proxyHost", "proxyPort", "apiKey"], (items) => {
        const newConfig: ProxyConfig = {
          proxyHost: (items.proxyHost as string) || DEFAULT_CONFIG.proxyHost,
          proxyPort: (items.proxyPort as number) || DEFAULT_CONFIG.proxyPort,
          apiKey: (items.apiKey as string) || DEFAULT_CONFIG.apiKey,
        };
        console.log("[QwenProxy] Config updated, reconnecting WS with new key");
        bridge.reconfigure(newConfig.proxyHost, newConfig.proxyPort, newConfig.apiKey);
      });
    }
  });

  chrome.runtime.sendMessage({ type: "contentScriptReady" });
}

main().catch(console.error);
