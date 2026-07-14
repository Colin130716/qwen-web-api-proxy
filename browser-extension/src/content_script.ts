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
} from "./lib/tool_calling";
import {
  type ProxyConfig,
  type PendingRequest,
  DEFAULT_CONFIG,
} from "./lib/types";
import { WsBridge } from "./lib/ws_bridge";
import { findInputElement, fillInput, clickSend, delay } from "./lib/dom_helper";
import {
  processSSEBuffer,
  handleCompletedResponse,
  fetchLastAssistantId,
} from "./lib/sse_handler";
import { pollChatForResponse } from "./lib/poller";

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

let abortController: AbortController | null = null;

// ── Thinking Mode ──
let thinkingEnabled = true;
let searchEnabled = false;

// ── SSE State ──
let pendingRequest: PendingRequest | null = null;

// Listen for SSE data from page fetch interception (via postMessage)
window.addEventListener("message", (event: MessageEvent) => {
  if (event.data?.source !== "__qwen_proxy") return;
  if (!pendingRequest) {
    console.warn("[QwenProxy] Received SSE data but no pending request");
    return;
  }

  if (event.data.type === "end") {
    handleCompletedResponse(pendingRequest);
    pendingRequest = null;
    return;
  }

  if (event.data.type === "chunk") {
    pendingRequest.sseBuffer += event.data.text;
    processSSEBuffer(pendingRequest);
  }
});

// ── Main ──
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
  window.addEventListener("message", (event: MessageEvent) => {
    if (event.data?.source !== "__qwen_proxy_response") return;
    const pd = event.data;
    if (!pendingRequest || pendingRequest.id !== pd.requestId) {
      console.debug("[ContentScript] Poll result for unknown request:", pd.requestId);
      return;
    }

    if (pd.type === "completed") {
      console.debug("[ContentScript] Polled response received, content length:", pd.content?.length);
      if (pd.reasoning) {
        bridge.send({ type: "reasoning", id: pendingRequest.id, content: pd.reasoning });
      }
      if (pd.content) {
        bridge.send({
          type: "chunk",
          id: pendingRequest.id,
          data: { content: pd.content, done: false },
        });
      }
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

      // Handle system-only requests (Cherry Studio split-request pattern)
      const hasUserContent = lastUserMessage && (
        typeof lastUserMessage.content === "string"
          ? (lastUserMessage.content as string).trim().length > 0
          : Array.isArray(lastUserMessage.content) && (lastUserMessage.content as unknown[]).length > 0
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

      // Command: /help
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
        bridge.send({ type: "chunk", id: msg.id, data: { content: helpText, done: false } });
        bridge.send({
          type: "done", id: msg.id,
          usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
          chat_context: { chatId, parentId, systemPrompt },
        });
        return;
      }

      // Command: /new
      if (userText === "/new") {
        console.log("[ContentScript] /new command received");
        try {
          const newChatId = await createQwenChat();
          chatId = newChatId;
          parentId = null;
          systemPrompt = null;
          console.log("[ContentScript] /new → chatId:", chatId);
          bridge.send({ type: "chunk", id: msg.id, data: { content: `New chat created: \`${chatId}\``, done: false } });
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

      // Command: /change <chat_id>
      const changeMatch = userText.match(/^\/change\s+(\S+)/);
      if (changeMatch) {
        const newChatId = changeMatch[1];
        console.log("[ContentScript] /change command, newChatId:", newChatId);
        try {
          const lastId = await fetchLastAssistantId(newChatId);
          chatId = newChatId;
          parentId = lastId;
          systemPrompt = null;
          bridge.send({ type: "chunk", id: msg.id, data: { content: `Switched to chat: \`${newChatId}\``, done: false } });
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

      // Command: /viewid
      if (userText === "/viewid") {
        console.log("[ContentScript] /viewid → chatId:", chatId);
        const id = chatId || "No active chat session";
        bridge.send({ type: "chunk", id: msg.id, data: { content: id, done: false } });
        bridge.send({
          type: "done", id: msg.id,
          usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
          chat_context: { chatId, parentId, systemPrompt },
        });
        return;
      }

      // Command: /viewchats
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
                items.push({ id: chat.id, title: chat.title, created: chat.created_at, updated: chat.updated_at });
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

          bridge.send({ type: "chunk", id: msg.id, data: { content: lines || "No chat sessions found.", done: false } });
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

      // Command: /deletechat <chat_id>
      const deleteMatch = userText.match(/^\/deletechat\s+(\S+)/);
      if (deleteMatch) {
        const targetId = deleteMatch[1];
        console.log("[ContentScript] /deletechat command, targetId:", targetId);
        try {
          const resp = await fetch(`https://chat.qwen.ai/api/v2/chats/${targetId}`, {
            method: "DELETE", credentials: "include", headers: { "Content-Type": "application/json" },
          });
          if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
          const body = await resp.json();
          const deleted = body?.data?.status === true;
          bridge.send({ type: "chunk", id: msg.id, data: { content: deleted ? `Chat deleted: \`${targetId}\`` : `Delete failed for: \`${targetId}\``, done: false } });
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

      // Command: /enable-thinking
      if (userText === "/enable-thinking") {
        thinkingEnabled = true;
        bridge.send({ type: "chunk", id: msg.id, data: { content: "Thinking mode enabled (quick → thinking). Next message will use thinking mode.", done: false } });
        bridge.send({
          type: "done", id: msg.id,
          usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
          chat_context: { chatId, parentId, systemPrompt },
        });
        return;
      }

      // Command: /disable-thinking
      if (userText === "/disable-thinking") {
        thinkingEnabled = false;
        bridge.send({ type: "chunk", id: msg.id, data: { content: "Thinking mode disabled (thinking → quick). Next message will use quick mode.", done: false } });
        bridge.send({
          type: "done", id: msg.id,
          usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
          chat_context: { chatId, parentId, systemPrompt },
        });
        return;
      }

      // Command: /enable-search
      if (userText === "/enable-search") {
        searchEnabled = true;
        bridge.send({ type: "chunk", id: msg.id, data: { content: "Auto search enabled. Next message will use web search.", done: false } });
        bridge.send({
          type: "done", id: msg.id,
          usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
          chat_context: { chatId, parentId, systemPrompt },
        });
        return;
      }

      // Command: /disable-search
      if (userText === "/disable-search") {
        searchEnabled = false;
        bridge.send({ type: "chunk", id: msg.id, data: { content: "Auto search disabled. Next message will not use web search.", done: false } });
        bridge.send({
          type: "done", id: msg.id,
          usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
          chat_context: { chatId, parentId, systemPrompt },
        });
        return;
      }

      // Command: /genimage <prompt>
      const genimageMatch = userText.match(/^\/genimage\s+(.+)/s);
      if (genimageMatch) {
        const imagePrompt = genimageMatch[1].trim();
        const t2iModel = msg.model || "qwen3.7-plus";
        console.log("[ContentScript] /genimage command, prompt:", imagePrompt.slice(0, 80), "model:", t2iModel);
        try {
          chatId = await createQwenChat(t2iModel, "t2i");
          parentId = null;
          const result = await sendQwenMessage(chatId, t2iModel, imagePrompt, null, undefined, false, false, [], "t2i");
          bridge.send({ type: "chunk", id: msg.id, data: { content: result.content || "Image generated.", done: false } });
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

      // Command: /genppt <prompt>
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
          const result1 = await sendQwenMessage(chatId, pptModel, pptPrompt, null, undefined, true, true, [], "slides");
          const draftPlan = result1.content || "";
          const result2 = await sendQwenMessage(chatId, pptModel, "开始", result1.parentId, undefined, true, true, [], "slides");
          let responseText = draftPlan;
          if (result2.content) {
            responseText += (responseText ? "\n\n---\n\n" : "") + result2.content;
          }
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
          bridge.send({ type: "chunk", id: msg.id, data: { content: responseText || "PPT generated.", done: false } });
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
        // Phase 1: Try direct Qwen API
        try {
          if (msg.tools && Array.isArray(msg.tools) && msg.tools.length > 0) {
            console.debug("[ContentScript] Injecting", msg.tools.length, "tool definitions");
            msg.messages = injectToolDefinitions(msg.messages, msg.tools);
          }

          const { text: prompt, files: rawFiles } = processOpenAIMessages(msg.messages, systemPrompt);
          systemPrompt = null;
          const model = msg.model || "qwen3.7-plus";
          console.debug("[ContentScript] Processed prompt (%d chars, %d raw files) model=%s", prompt.length, rawFiles.length, model);

          let uploadedFiles: UploadedFileInfo[] = [];
          if (rawFiles.length > 0) {
            console.log("[ContentScript] Uploading %d images via STS/OSS...", rawFiles.length);
            uploadedFiles = await uploadAllImages(rawFiles, abortController?.signal);
            console.log("[ContentScript] Uploaded %d images", uploadedFiles.length);
          }

          if (!chatId) {
            console.log("[ContentScript] chatId is null, calling createQwenChat(model=%s)...", model);
            chatId = await createQwenChat(model);
            console.log("[ContentScript] createQwenChat() returned:", chatId);
            parentId = null;
          }

          console.debug("[ContentScript] Using chat:", chatId, "parentId:", parentId, "model:", model);
          if (pendingRequest) pendingRequest.isPolling = false;

          const { content, reasoning, parentId: newParentId, usage: qwenUsage } = await sendQwenMessage(
            chatId, model, prompt,
            uploadedFiles.length > 0 ? null : parentId,
            abortController?.signal, thinkingEnabled, searchEnabled, uploadedFiles,
            undefined,
            {
              onReasoning: (text) => {
                if (pendingRequest?.id === msg.id) {
                  bridge.send({ type: "reasoning", id: msg.id, content: text });
                }
              },
              onContent: (text) => {
                if (pendingRequest?.id === msg.id) {
                  bridge.send({ type: "chunk", id: msg.id, data: { content: text, done: false } });
                }
              },
            },
          );

          parentId = newParentId;
          console.debug("[ContentScript] Streaming complete, content length:", content.length);

          const toolCalls = parseToolCalls(content);

          if (toolCalls && pendingRequest?.id === msg.id) {
            bridge.send({ type: "tool_calls", id: msg.id, tool_calls: toolCalls });
          }
          if (pendingRequest?.id === msg.id) {
            bridge.send({
              type: "done", id: msg.id,
              usage: qwenUsage ?? { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
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

        // Phase 2: Fallback — DOM automation + polling
        console.debug("[ContentScript] Requesting MAIN-world DOM via service worker...");

        const domResult: any = await chrome.runtime.sendMessage({
          type: "executeDom", text: lastUserMessage.content, requestId: msg.id,
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
          pollChatForResponse(
            msg.id, bridge, chatId,
            () => pendingRequest,
            () => { pendingRequest = null; },
          ).catch((err: any) => {
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
        bridge.send({ type: "error", id: msg.id, error: { message: err.message || "Unknown error in execute handler" } });
        return;
      }

      setTimeout(() => {
        if (pendingRequest?.id === msg.id) {
          console.warn("[ContentScript] Request timed out (no response)");
          bridge.send({ type: "error", id: msg.id, error: { message: "Request timed out waiting for Qwen response" } });
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
