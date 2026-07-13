# Multi-Extension Connection Pool

**Date**: 2026-07-12
**Status**: Draft
**License**: MIT

## Summary

Replace the single-WebSocket `ConnectionManager` with a connection pool supporting multiple concurrent browser extensions. All connected extensions share the same Qwen account; the proxy distributes client requests across them with session affinity for multi-turn conversation support.

## Motivation

Currently the proxy supports exactly one browser extension at a time. If a second extension connects, the first is disconnected. This prevents:

- **Load balancing**: distributing concurrent requests across multiple browser tabs
- **Fault tolerance**: if one tab crashes, another can continue serving
- **Tab lifecycle**: users can open/close tabs without disrupting the proxy

The driving use case is **same-account load balancing** — multiple tabs all logged into the same `chat.qwen.ai` account.

## Requirements

1. Multiple browser extensions connect simultaneously to the same proxy
2. Client requests are distributed across connected extensions
3. Multi-turn conversation works — same session → same extension
4. Session identification via `X-Session-ID` header, with client-IP fallback
5. No changes to `WsBridge` (extension-side WebSocket client)
6. Backward compatible: existing single-extension setups continue to work
7. Content script state (`currentChatId`, `currentParentId`) moves from module-level to request-scoped

## Architecture

```
                  ┌──────────────────────────────────────────┐
                  │              Proxy Server                 │
                  │                                          │
                  │   ConnectionPool                          │
                  │   ├── conn_1: ws, queue, session=sess_a   │
                  │   ├── conn_2: ws, queue, session=sess_b   │
                  │   └── conn_3: ws, queue, session=null     │
                  │                                          │
                  │   SessionTable                            │
                  │   ├── sess_a → {ext:1, chatCtx:{...}}    │
                  │   └── sess_b → {ext:2, chatCtx:{...}}    │
                  └───────────────┬──────────────────────────┘
                                  │
        ┌─────────────────────────┼─────────────────────┐
        │    POST /v1/chat/       │ execute              │
        │    X-Session-ID: sess_a │ + chat_context       │
        │                         │                      │
   Client A                  Extension 1            Extension 2
                             (Tab 1)                (Tab 2)
```

### Core principle

The proxy is the **source of truth for session state**. Instead of the content script holding `currentChatId` at module level, the proxy sends `chat_context` with every execute message and receives the updated context back in the `done` response.

> `chat_context` is carried in the **`done` message only** (not in streaming `chunk` messages), because `chatId` and `parentId` are only known after the request completes.

## WS Protocol Changes

### Execute message (proxy → extension)

```json
{
  "type": "execute",
  "id": "uuid",
  "messages": [...],
  "tools": [...],
  "options": {"stream": true},
  "chat_context": {
    "chatId": "xxx123",
    "parentId": "yyy456",
    "systemPrompt": null
  }
}
```

### Done message (extension → proxy)

```json
{
  "type": "done",
  "id": "uuid",
  "usage": {"prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0},
  "chat_context": {
    "chatId": "xxx123",
    "parentId": "zzz789",
    "systemPrompt": null
  }
}
```

`chat_context` is **only in the `done` message**. Streaming `chunk` and `error` messages do not carry it, since `chatId`/`parentId` are only finalized at request completion.

## ConnectionPool (ws_manager.py, rewrite)

### ExtensionConnection

```python
class ExtensionConnection:
    def __init__(self, websocket: WebSocket):
        self.websocket = websocket
        self.queue: asyncio.Queue[dict[str, Any]] = asyncio.Queue()
        self.connection_id: int     # auto-increment
        self.session_id: str | None = None  # currently assigned session
        self.status: str = "idle"   # "idle" | "busy"
        self.connected_at: float = time.time()

    async def reader_loop(self):
        """Reads all messages from this WebSocket.
        Called inline from pool.connect() so the ASGI handler stays alive."""
        ws = self.websocket
        try:
            while True:
                text = await ws.receive_text()
                if text == "ping":
                    await ws.send_text("pong")
                else:
                    data = json.loads(text)
                    await self.queue.put(data)
        except Exception:
            pass
        finally:
            await self.disconnect()
```

### ConnectionPool

```python
class ConnectionPool:
    def __init__(self):
        self._connections: dict[int, ExtensionConnection] = {}
        self._session_table: dict[str, SessionInfo] = {}
        self._next_id: int = 0
        self._lock: asyncio.Lock = asyncio.Lock()

    async def connect(self, websocket: WebSocket) -> None:
        """Accept a WS connection (already authenticated), add to pool, run reader loop inline."""
        await websocket.accept()
        conn = ExtensionConnection(websocket, self._next_id)
        self._next_id += 1
        async with self._lock:
            self._connections[conn.connection_id] = conn
        await conn.reader_loop()  # inline — ASGI handler stays alive
        # Reader loop exited → cleanup
        async with self._lock:
            self._cleanup_connection(conn.connection_id)

    async def send_to_session(self, session_id: str, data: dict) -> None:
        """Send JSON to the extension assigned to this session."""
        ext_id = self._session_table[session_id].ext_id
        conn = self._connections[ext_id]
        await conn.websocket.send_text(json.dumps(data))

    async def receive_from_session(self, session_id: str) -> dict:
        """Receive next message from the extension assigned to this session."""
        ext_id = self._session_table[session_id].ext_id
        conn = self._connections[ext_id]
        return await conn.queue.get()

    def resolve_session(self, session_id: str, client_ip: str) -> SessionInfo:
        """Find or create a session→extension mapping."""
        if session_id in self._session_table:
            return self._session_table[session_id]
        # Find an idle connection
        idle = self._find_idle_connection()
        if idle is None:
            raise RuntimeError("No available extensions")
        info = SessionInfo(ext_id=idle.connection_id, client_ip=client_ip)
        self._session_table[session_id] = info
        idle.session_id = session_id
        return info

    def release_session(self, session_id: str) -> None:
        """Release the extension assigned to this session."""
        if session_id in self._session_table:
            info = self._session_table.pop(session_id)
            if info.ext_id in self._connections:
                self._connections[info.ext_id].session_id = None
```

### SessionInfo

```python
@dataclass
class SessionInfo:
    ext_id: int
    client_ip: str
    chat_context: ChatContext | None = None
    last_active: float = time.time()
```

## API Changes (api.py)

### Session resolution

```python
def _resolve_session(request: Request) -> str:
    session_id = request.headers.get("X-Session-ID")
    if not session_id:
        session_id = f"ip:{request.client.host}"
    return session_id
```

### Chat completions handler

```python
@app.post("/v1/chat/completions")
async def chat_completions(request: Request):
    session_id = _resolve_session(request)
    try:
        session = pool.resolve_session(session_id, request.client.host)
    except RuntimeError:
        raise HTTPException(503, "No available extension")

    execute_msg = {
        "type": "execute",
        "id": request_id,
        "messages": messages,
        "chat_context": asdict(session.chat_context) if session.chat_context else None,
    }
    if tools:
        execute_msg["tools"] = tools
    if stream:
        execute_msg["options"] = {"stream": True}

    await pool.send_to_session(session_id, execute_msg)

    # ... read responses, update chat_context ...
```

### Health endpoint

```python
@app.get("/health")
async def health():
    return {
        "status": "ok",
        "extensions_connected": pool.connected_count,
        "sessions_active": pool.session_count,
        "api_key": config.api_key,
    }
```

## Content Script Changes (content_script.ts)

### Remove module-level state

```typescript
// DELETE:
let currentChatId: string | null = null;
let currentParentId: string | null = null;
let cachedSystemPrompt: string | null = null;
```

### Execute handler reads chat_context

```typescript
bridge.onMessage(async (msg: any) => {
  if (msg.type === "execute") {
    const ctx = msg.chat_context || {};
    let chatId = ctx.chatId || null;
    let parentId = ctx.parentId || null;
    let systemPrompt = ctx.systemPrompt || null;

    // ... command handling with local variables ...

    // Return updated context
    bridge.send({
      type: "done",
      id: msg.id,
      usage: {...},
      chat_context: {
        chatId: chatId,
        parentId: parentId,
        systemPrompt: systemPrompt,
      },
    });
  }
});
```

### Command handlers use local state

- `/new`: creates chat → returns `chatId`, `parentId: null`
- `/change <id>`: switches chat → returns `chatId`, fetched `parentId`
- `/viewid`: reads local `chatId`, returns it

### Cherry Studio split-request compatibility

The `systemPrompt` is now managed by the proxy's `SessionInfo.chat_context`. System-only execute messages update `chat_context.systemPrompt` on the proxy side; user-message executes include it.

## Session Lifecycle

| Event | Behavior |
|-------|----------|
| Session idle > 180s | Session mapping retained but extension **may** accept a new session. If extension is reassigned, old session mapping is evicted. |
| Session idle > 600s | Session fully cleaned unconditionally; next request treated as new |
| Extension WS disconnect | Clean up all sessions assigned to that extension immediately |
| All extensions busy | Return 503 "No available extensions" |
| Extension WS drops mid-request | Return 502 "Extension disconnected", session cleaned |
| Request timeout (150s) | Return 408, session mapping cleaned |
| Session assignment conflict | Not possible: each session maps to exactly one extension at a time; extension reassignment first evicts old session |

## Files Changed

| File | Change |
|------|--------|
| `proxy_server/server/ws_manager.py` | Rewrite: ~150 lines. Replace `ConnectionManager` singleton with `ConnectionPool` + `ExtensionConnection` |
| `proxy_server/server/api.py` | ~50 lines. Session resolution, pass/receive `chat_context`, health update |
| `browser-extension/src/content_script.ts` | ~40 lines. Module variables → local variables, `chat_context` in execute/done messages |
| `browser-extension/src/lib/types.ts` | ~10 lines. Add `ChatContext` type |
| `browser-extension/src/lib/ws_bridge.ts` | 0 lines. No changes needed |
| `browser-extension/src/lib/qwen_api.ts` | 0 lines. Already accepts chatId/parentId params |

## Backward Compatibility

- Single extension: works identically, just uses one connection in the pool
- Content script state model change: old content scripts won't send `chat_context` → proxy treats missing context as new session
- API clients not sending `X-Session-ID`: fall back to client IP → same behavior as before for single-client setups

## Security Considerations

- WebSocket authentication unchanged (api_key query param)
- Session IDs are not authenticated beyond the extension's WS auth
- IP-based session fallback is susceptible to NAT sharing (acceptable for the use case)
