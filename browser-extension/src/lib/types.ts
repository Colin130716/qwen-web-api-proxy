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

/** Pending request state for SSE and polling coordination */
export interface PendingRequest {
  id: string;
  bridge: WsBridge;
  sseBuffer: string;
  thinkingContent: string;
  thinkingFinished: boolean;
  hasSentThinking: boolean;
  hasSentAnswer: boolean;
  /** If true, polling is the primary delivery path; SSE data is buffered for debug only */
  isPolling: boolean;
  /** Last usage info captured from SSE events — used by handleCompletedResponse */
  lastUsage?: UsageInfo;
}

/** Usage info from Qwen SSE */
export interface UsageInfo {
  input_tokens?: number;
  output_tokens?: number;
  total_tokens?: number;
}

/** A single choice's delta in an SSE event */
export interface SseChoiceDelta {
  phase?: string | null;
  content?: unknown;
  status?: string;
  extra?: Record<string, unknown>;
}

/** Parsed SSE event (Qwen chat/completions stream) */
export interface SseEvent {
  choices?: Array<{
    delta?: SseChoiceDelta;
  }>;
  usage?: UsageInfo;
  "response.created"?: { response_id?: string };
}

/** Assistant message from GET /api/v2/chats/<id> response */
export interface ChatAssistantMessage {
  id?: string;
  role?: string;
  done?: boolean;
  status?: string;
  content_list?: Array<{
    phase?: string;
    content?: string;
    extra?: {
      summary_thought?: { content: string | string[] };
    };
  }>;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    total_tokens?: number;
  };
}

import type { WsBridge } from "./ws_bridge";
