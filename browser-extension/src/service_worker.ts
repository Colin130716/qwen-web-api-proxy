import { DEFAULT_CONFIG, type ProxyConfig } from "./lib/types";

// Track which tabs have been injected to prevent duplicate injection
const injectedTabs = new Set<number>();

// Inject page script (fetch/XHR interception) into the page's main world
async function injectPageScript(tabId: number): Promise<void> {
  if (injectedTabs.has(tabId)) {
    console.debug(`[ServiceWorker] Tab ${tabId} already injected, skipping`);
    return;
  }
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      world: "MAIN",
      files: ["src/page_script.js"],
    });
    injectedTabs.add(tabId);
    console.debug(`[ServiceWorker] Page script injected into tab ${tabId}`);
  } catch (err) {
    console.warn("[ServiceWorker] Failed to inject page script:", err);
  }
}

// Clean up injected tabs when they're closed
chrome.tabs.onRemoved.addListener((tabId) => {
  injectedTabs.delete(tabId);
});

// Execute DOM automation + poll for response in the page's MAIN world
// Content script's isolated world cannot trigger React's value tracker or
// use page origin fetch() with cookies for the chat API.
// @deprecated Only used as DOM fallback when direct API call fails.
// Will be removed in a future version.
async function executeDomInMainWorld(
  tabId: number,
  text: string,
  requestId: string,
): Promise<{ success: boolean; error?: string }> {
  try {
    const [result] = await chrome.scripting.executeScript({
      target: { tabId },
      world: "MAIN",
      // The entire function body (including `startPolling`) is serialized
      // and runs in the page's MAIN world. Only `fillText` and `reqId`
      // from `args` are available — no closures, no extension APIs.
      func: (fillText: string, reqId: string): Promise<{ success: boolean; error?: string; chatId?: string }> => {
        return new Promise((resolve) => {
          // ── Step 0: Find the correct input element ──
          try {
            var ta = document.querySelector<HTMLTextAreaElement | HTMLInputElement>(
              "textarea.message-input-textarea, textarea:not([disabled]):not([readonly])",
            );
            if (!ta) {
              resolve({ success: false, error: "textarea not found" });
              return;
            }

            ta.focus();
            ta.select();

            var cmdOk = false;
            if (document.execCommand) {
              try { cmdOk = document.execCommand("insertText", false, fillText); } catch (_e) { /* empty */ }
            }
            if (!cmdOk || ta.value.length === 0) {
              ta.value = fillText;
              try {
                ta.dispatchEvent(new InputEvent("input", {
                  inputType: "insertText", data: fillText,
                  bubbles: true, cancelable: true, composed: true,
                }));
              } catch (_e) { /* empty */ }
              ta.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
              ta.dispatchEvent(new Event("change", { bubbles: true }));
            }
          } catch (err) {
            resolve({ success: false, error: String(err) });
            return;
          }

          // Wait and press Enter
          setTimeout(function () {
            try {
              var ta = document.querySelector<HTMLTextAreaElement>("textarea.message-input-textarea");
              if (!ta) { resolve({ success: false, error: "textarea lost" }); return; }

              ta.dispatchEvent(new KeyboardEvent("keydown", {
                key: "Enter", code: "Enter", keyCode: 13, which: 13,
                bubbles: true, cancelable: true, composed: true,
              }));
              ta.dispatchEvent(new KeyboardEvent("keypress", {
                key: "Enter", code: "Enter", keyCode: 13, which: 13,
                bubbles: true, cancelable: true,
              }));
              ta.dispatchEvent(new KeyboardEvent("keyup", {
                key: "Enter", code: "Enter", keyCode: 13, which: 13,
                bubbles: true, cancelable: true,
              }));

              console.log("[QwenProxy:SW:MAIN] Enter dispatched");

              // Return chat ID from URL so content script can poll
              var pathParts = window.location.pathname.split("/");
              var chatId = pathParts[pathParts.length - 1];
              if (chatId && chatId !== "c" && chatId.length >= 20) {
                resolve({ success: true, chatId: chatId });
              } else {
                // Chat ID not yet available — try again after short delay
                setTimeout(function () {
                  pathParts = window.location.pathname.split("/");
                  chatId = pathParts[pathParts.length - 1];
                  resolve({ success: true, chatId: (chatId && chatId !== "c" && chatId.length >= 20) ? chatId : undefined });
                }, 3000);
              }
            } catch (err) {
              resolve({ success: false, error: String(err) });
            }
          }, 1200);
        });
      },
      args: [text, requestId],
    });
    return result?.result || { success: false, error: "no result" };
  } catch (err) {
    return { success: false, error: String(err) };
  }
}

// Auto-inject page script on navigation (dedup'd via injectedTabs set)
chrome.webNavigation.onCommitted.addListener((details) => {
  if (
    details.frameId === 0 &&
    (details.url.includes("chat.qwen.ai") || details.url.includes("chat.qwenlm.ai"))
  ) {
    injectPageScript(details.tabId);
  }
});

// Set default config on installation
chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.sync.get(
    ["proxyHost", "proxyPort", "apiKey"],
    (items) => {
      const defaults: Record<string, unknown> = {};
      if (!items.proxyHost) defaults.proxyHost = DEFAULT_CONFIG.proxyHost;
      if (!items.proxyPort) defaults.proxyPort = DEFAULT_CONFIG.proxyPort;
      if (!items.apiKey) defaults.apiKey = DEFAULT_CONFIG.apiKey;
      if (Object.keys(defaults).length > 0) {
        chrome.storage.sync.set(defaults);
      }
    },
  );
});

// Handle messages from popup and content script
chrome.runtime.onMessage.addListener(
  (
    message: { type: string; config?: Record<string, unknown>; text?: string; requestId?: string },
    sender,
    sendResponse: (response: unknown) => void,
  ) => {
    switch (message.type) {
      case "getConfig":
        chrome.storage.sync.get(
          ["proxyHost", "proxyPort", "apiKey"],
          (items) => {
            sendResponse({
              proxyHost: items.proxyHost || DEFAULT_CONFIG.proxyHost,
              proxyPort: items.proxyPort || DEFAULT_CONFIG.proxyPort,
              apiKey: items.apiKey || DEFAULT_CONFIG.apiKey,
            } satisfies ProxyConfig);
          },
        );
        return true;

      case "setConfig":
        chrome.storage.sync.set(message.config ?? {}, () => {
          chrome.tabs.query(
            { url: "https://chat.qwen.ai/*" },
            (tabs) => {
              for (const tab of tabs) {
                if (tab.id) {
                  chrome.tabs.sendMessage(tab.id, { type: "configUpdated", config: message.config });
                }
              }
            },
          );
          sendResponse({ success: true });
        });
        return true;

      case "injectPageScript":
        if (sender.tab?.id) {
          injectPageScript(sender.tab.id);
        }
        sendResponse({ success: true });
        return true;

      case "contentScriptReady":
        sendResponse({ success: true });
        return true;

      case "executeDom":
        if (!sender.tab?.id) {
          sendResponse({ success: false, error: "no tab" });
          return true;
        }
        (async () => {
          // requestId is passed through to correlate polled response
          const result = await executeDomInMainWorld(
            sender.tab!.id!,
            message.text as string,
            message.requestId as string,
          );
          sendResponse(result);
        })();
        return true;

      case "discoverApiKey":
        chrome.storage.sync.get(
          ["proxyHost", "proxyPort"],
          (items) => {
            const host = (items.proxyHost as string) || DEFAULT_CONFIG.proxyHost;
            const port = (items.proxyPort as number) || DEFAULT_CONFIG.proxyPort;
            fetch(`http://${host}:${port}/health`, { signal: AbortSignal.timeout(3000) })
              .then((r) => r.json())
              .then((data) => sendResponse({ apiKey: data.api_key ?? null }))
              .catch(() => sendResponse({ apiKey: null }));
          },
        );
        return true;

      default:
        sendResponse({ error: `Unknown message type: ${message.type}` });
    }
  },
);
