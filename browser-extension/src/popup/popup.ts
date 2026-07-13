import { type ProxyConfig, DEFAULT_CONFIG } from "../lib/types";

const statusDot = document.getElementById("statusDot") as HTMLSpanElement;
const statusText = document.getElementById("statusText") as HTMLSpanElement;
const endpointDisplay = document.getElementById("endpointDisplay") as HTMLElement;
const form = document.getElementById("configForm") as HTMLFormElement;
const resetBtn = document.getElementById("resetBtn") as HTMLButtonElement;
const hostInput = document.getElementById("proxyHost") as HTMLInputElement;
const portInput = document.getElementById("proxyPort") as HTMLInputElement;
const apiKeyInput = document.getElementById("apiKey") as HTMLInputElement;

// Load current config from chrome.storage directly
function loadConfig(): Promise<ProxyConfig> {
  return new Promise((resolve) => {
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
}

// Check connection status via proxy server health endpoint
async function checkStatus(): Promise<void> {
  try {
    const config = await loadConfig();

    const resp = await fetch(
      `http://${config.proxyHost}:${config.proxyPort}/health`,
      { signal: AbortSignal.timeout(3000) },
    );
    const data = await resp.json();

    if (data.status === "ok") {
      // Auto-sync API key from proxy if stored key differs
      if (data.api_key && data.api_key !== config.apiKey) {
        console.log("[Popup] Auto-syncing API key from proxy");
        await saveConfig({ apiKey: data.api_key });
        apiKeyInput.value = data.api_key;
        config.apiKey = data.api_key;
      }

      if (data.extension_connected) {
        setStatus("connected", "Connected & Extension Active");
      } else {
        setStatus("warning", "Server Running (no extension connection)");
      }
    } else {
      setStatus("error", "Server Error");
    }
  } catch {
    setStatus("disconnected", "Proxy Server Unreachable");
  }
}

function updateEndpoint(host: string, port: number): void {
  endpointDisplay.textContent = `http://${host}:${port}/v1`;
}

function setStatus(
  level: "connected" | "warning" | "error" | "disconnected",
  text: string,
): void {
  statusDot.className = `status-dot ${level}`;
  statusText.textContent = text;
}

// Save config to chrome.storage and notify content scripts
async function saveConfig(config: Partial<ProxyConfig>): Promise<void> {
  // Save via service worker so it broadcasts configUpdated to active tabs
  await chrome.runtime.sendMessage({ type: "setConfig", config });
}

// Reset to defaults
function resetConfig(): void {
  hostInput.value = DEFAULT_CONFIG.proxyHost;
  portInput.value = String(DEFAULT_CONFIG.proxyPort);
  apiKeyInput.value = DEFAULT_CONFIG.apiKey;
}

function applyConfig(config: ProxyConfig): void {
  hostInput.value = config.proxyHost;
  portInput.value = String(config.proxyPort);
  apiKeyInput.value = config.apiKey;
  updateEndpoint(config.proxyHost, config.proxyPort);
}

document.addEventListener("DOMContentLoaded", async () => {
  const config = await loadConfig();
  applyConfig(config);
  await checkStatus();
  const statusInterval = setInterval(checkStatus, 3000);
  window.addEventListener("unload", () => {
    clearInterval(statusInterval);
  });
});

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  const config: Partial<ProxyConfig> = {
    proxyHost: hostInput.value,
    proxyPort: Number(portInput.value),
    apiKey: apiKeyInput.value,
  };
  await saveConfig(config);
  applyConfig(config as ProxyConfig);
  statusText.textContent = "Saved! Reconnect if needed.";
  setTimeout(() => checkStatus(), 1000);
});

resetBtn.addEventListener("click", () => {
  resetConfig();
  updateEndpoint(DEFAULT_CONFIG.proxyHost, DEFAULT_CONFIG.proxyPort);
});
