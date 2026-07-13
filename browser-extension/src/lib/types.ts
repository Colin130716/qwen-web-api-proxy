/** Chat session context passed between proxy and content script */
export interface ChatContext {
  chatId: string | null;
  parentId: string | null;
  systemPrompt: string | null;
}

/** Configuration stored in chrome.storage */
export interface ProxyConfig {
  proxyHost: string;
  proxyPort: number;
  apiKey: string;
}

export const DEFAULT_CONFIG: ProxyConfig = {
  proxyHost: "127.0.0.1",
  proxyPort: 11434,
  apiKey: "sk-qwen-proxy",
};

/** Message from proxy server to extension (via WebSocket) */
export interface ExecuteMessage {
  type: "execute";
  id: string;
  model?: string;
  messages: { role: string; content: string }[];
  tools?: { type: string; function: Record<string, unknown> }[];
  options?: { stream?: boolean };
  chat_context?: ChatContext;
}

/** Messages from extension to proxy server (via WebSocket) */
export interface ChunkMessage {
  type: "chunk";
  id: string;
  data: { content: string; done: boolean };
}

export interface DoneMessage {
  type: "done";
  id: string;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
  chat_context?: ChatContext;
}

export interface ErrorMessage {
  type: "error";
  id: string;
  error: { message: string; code?: string };
}

export type ExtensionMessage = ExecuteMessage | ChunkMessage | DoneMessage | ErrorMessage;

/** Proxy connection status for UI */
export type ConnectionStatus =
  | "disconnected"
  | "connecting"
  | "connected"
  | "error";
