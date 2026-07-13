import { type ExtensionMessage, type ConnectionStatus } from "./types";

type MessageHandler = (msg: ExtensionMessage) => void;
type StatusChangeHandler = (status: ConnectionStatus) => void;

export class WsBridge {
  private ws: WebSocket | null = null;
  private host: string;
  private port: number;
  private apiKey: string;
  private reconnectAttempts = 0;
  private readonly maxReconnectDelay = 30000;
  private readonly initialReconnectDelay = 1000;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private messageHandlers: Set<MessageHandler> = new Set();
  private statusHandlers: Set<StatusChangeHandler> = new Set();
  private _status: ConnectionStatus = "disconnected";
  private pingInterval: ReturnType<typeof setInterval> | null = null;

  constructor(host: string, port: number, apiKey: string) {
    this.host = host;
    this.port = port;
    this.apiKey = apiKey;
  }

  get status(): ConnectionStatus {
    return this._status;
  }

  private setStatus(status: ConnectionStatus): void {
    this._status = status;
    this.statusHandlers.forEach((h) => h(status));
  }

  onMessage(handler: MessageHandler): () => void {
    this.messageHandlers.add(handler);
    return () => this.messageHandlers.delete(handler);
  }

  onStatusChange(handler: StatusChangeHandler): () => void {
    this.statusHandlers.add(handler);
    return () => this.statusHandlers.delete(handler);
  }

  async connect(): Promise<void> {
    if (this.ws?.readyState === WebSocket.OPEN) return;

    this.setStatus("connecting");
    const url = `ws://${this.host}:${this.port}/ws?api_key=${encodeURIComponent(this.apiKey)}`;

    try {
      this.ws = new WebSocket(url);

      this.ws.onopen = () => {
        this.reconnectAttempts = 0;
        this.setStatus("connected");
        this.startPing();
      };

      this.ws.onclose = () => {
        this.setStatus("disconnected");
        this.stopPing();
        this.scheduleReconnect();
      };

      this.ws.onerror = () => {
        this.setStatus("error");
      };

      this.ws.onmessage = (event: MessageEvent) => {
        if (typeof event.data !== "string" || !event.data.startsWith("{")) {
          console.debug("[WsBridge] Skipping non-JSON message:", typeof event.data, String(event.data).slice(0, 100));
          return;
        }
        try {
          const msg = JSON.parse(event.data) as ExtensionMessage;
          console.debug("[WsBridge] Parsed message type:", msg.type);
          this.messageHandlers.forEach((h) => h(msg));
        } catch (e) {
          console.error("[WsBridge] Failed to parse message:", e);
        }
      };
    } catch {
      this.setStatus("error");
      this.scheduleReconnect();
    }
  }

  disconnect(): void {
    this.stopPing();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.ws?.close();
    this.ws = null;
    this.setStatus("disconnected");
  }

  send(data: Record<string, unknown>): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(data));
    } else {
      console.warn("[WsBridge] Cannot send: WebSocket not connected");
    }
  }

  /** Update host/port/key and reconnect. Used when config changes at runtime. */
  reconfigure(host: string, port: number, apiKey: string): void {
    console.log("[WsBridge] reconfigure called, host:", host, "port:", port);
    // Prevent stale onclose from old WS (fires async after close()) from
    // scheduling a reconnect or overwriting the new connection's status.
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.stopPing();
    this.reconnectAttempts = 0;

    const oldWs = this.ws;
    this.ws = null;
    if (oldWs) {
      oldWs.onclose = null;   // detach handler so it won't fire scheduleReconnect
      oldWs.onerror = null;
      oldWs.close();
    }

    this.host = host;
    this.port = port;
    this.apiKey = apiKey;
    this.setStatus("disconnected");
    this.connect();
  }

  private scheduleReconnect(): void {
    const delay = Math.min(
      this.initialReconnectDelay * Math.pow(2, this.reconnectAttempts),
      this.maxReconnectDelay,
    );
    this.reconnectAttempts++;
    console.log(
      `[WsBridge] Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts})`,
    );

    this.reconnectTimer = setTimeout(() => {
      this.connect();
    }, delay);
  }

  private startPing(): void {
    this.stopPing();
    this.pingInterval = setInterval(() => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.ws.send("ping");
      }
    }, 15000);
  }

  private stopPing(): void {
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
      this.pingInterval = null;
    }
  }
}
