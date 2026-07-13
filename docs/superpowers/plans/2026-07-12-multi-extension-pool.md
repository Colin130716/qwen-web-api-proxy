# Multi-Extension Connection Pool Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace single-extension WebSocket connection with a connection pool supporting multiple concurrent browser extensions, with session affinity for multi-turn conversations.

**Architecture:** Proxy manages a `ConnectionPool` — each extension is an `ExtensionConnection` with its own queue and inline reader loop. Session state (`chatId`, `parentId`, `systemPrompt`) is managed by the proxy via `SessionInfo` and passed through `chat_context` in execute/done messages. Content script becomes stateless — reads chat context from execute messages instead of module-level variables.

**Tech Stack:** Python 3.11+ / FastAPI / asyncio, TypeScript / Chrome MV3 extension

## Global Constraints

- WS reader loop must run inline (never `asyncio.create_task()`) — Starlette drops the ASGI scope if the handler returns
- Python >= 3.11 required
- No tests in repo — manual verification required after each task
- Backward compatible: existing single-extension setups must continue to work
- No changes to `browser-extension/src/lib/ws_bridge.ts`

---

### Task 1: Add ChatContext Type (types.ts)

**Files:**
- Modify: `browser-extension/src/lib/types.ts`

**Interfaces:**
- Consumes: nothing
- Produces: `ChatContext` interface, updated `ExecuteMessage` and `DoneMessage` types

- [ ] **Step 1: Add ChatContext interface and update message types**

Edit `browser-extension/src/lib/types.ts`:

```typescript
/** Chat session context passed between proxy and content script */
export interface ChatContext {
  chatId: string | null;
  parentId: string | null;
  systemPrompt: string | null;
}
```

Update `ExecuteMessage` to include `chat_context`:

```typescript
export interface ExecuteMessage {
  type: "execute";
  id: string;
  messages: { role: string; content: string }[];
  tools?: { type: string; function: Record<string, unknown> }[];
  options?: { stream?: boolean };
  chat_context?: ChatContext;
}
```

Update `DoneMessage` to include `chat_context`:

```typescript
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
```

- [ ] **Step 2: Verify**

```bash
cd browser-extension && npx tsc --noEmit
```
Expected: No type errors.

- [ ] **Step 3: Commit**

```bash
git add browser-extension/src/lib/types.ts
git commit -m "feat: add ChatContext type for session state passing"
```

---

### Task 2: Rewrite ws_manager.py — ConnectionPool

**Files:**
- Rewrite: `proxy_server/server/ws_manager.py`

**Interfaces:**
- Consumes: nothing
- Produces: `ConnectionPool` singleton (`pool`), `ExtensionConnection` class, `SessionInfo` dataclass

- [ ] **Step 1: Write the new ws_manager.py**

Write `proxy_server/server/ws_manager.py` with the following classes:

```python
from __future__ import annotations

import asyncio
import json
import logging
import time
from dataclasses import dataclass, asdict
from typing import Any

from fastapi import WebSocket

logger = logging.getLogger(__name__)


@dataclass
class ChatContext:
    chatId: str | None = None
    parentId: str | None = None
    systemPrompt: str | None = None


@dataclass
class SessionInfo:
    ext_id: int
    client_ip: str
    chat_context: ChatContext | None = None
    last_active: float = 0.0


class ExtensionConnection:
    """One browser extension WebSocket connection with its own queue and reader loop."""

    def __init__(self, websocket: WebSocket, connection_id: int) -> None:
        self.websocket = websocket
        self.queue: asyncio.Queue[dict[str, Any]] = asyncio.Queue()
        self.connection_id = connection_id
        self.session_id: str | None = None  # currently assigned session
        self._disconnected = False

    async def reader_loop(self) -> None:
        """Reads all messages from this WebSocket.
        Called inline from pool.connect() so the ASGI handler stays alive."""
        ws = self.websocket
        try:
            while True:
                text = await ws.receive_text()
                if text == "ping":
                    await ws.send_text("pong")
                else:
                    try:
                        data = json.loads(text)
                        await self.queue.put(data)
                    except json.JSONDecodeError:
                        logger.warning("Invalid JSON from extension (len=%d)", len(text))
        except Exception as exc:
            logger.debug("Extension reader loop ended: %s", exc)
        finally:
            self._disconnected = True

    @property
    def is_disconnected(self) -> bool:
        return self._disconnected

    async def send_json(self, data: dict[str, Any]) -> None:
        if not self._disconnected:
            await self.websocket.send_text(json.dumps(data))


class ConnectionPool:
    """Manages multiple extension WebSocket connections with session affinity."""

    def __init__(self) -> None:
        self._connections: dict[int, ExtensionConnection] = {}
        self._session_table: dict[str, SessionInfo] = {}
        self._next_id: int = 0
        self._lock = asyncio.Lock()

    @property
    def connected_count(self) -> int:
        return len(self._connections)

    @property
    def session_count(self) -> int:
        return len(self._session_table)

    async def connect(self, websocket: WebSocket) -> None:
        """Accept a WS connection (already authenticated), add to pool, run reader loop inline."""
        await websocket.accept()
        conn_id = self._next_id
        self._next_id += 1
        conn = ExtensionConnection(websocket, conn_id)
        async with self._lock:
            self._connections[conn_id] = conn
        logger.info("Extension connected (id=%d, total=%d)", conn_id, len(self._connections))
        try:
            await conn.reader_loop()
        finally:
            async with self._lock:
                self._cleanup_connection(conn_id)
            logger.info("Extension disconnected (id=%d, remaining=%d)", conn_id, len(self._connections))

    def _cleanup_connection(self, conn_id: int) -> None:
        """Remove connection and evict all sessions assigned to it."""
        self._connections.pop(conn_id, None)
        evicted = [sid for sid, info in self._session_table.items() if info.ext_id == conn_id]
        for sid in evicted:
            del self._session_table[sid]
            logger.debug("Evicted session %s (extension %d disconnected)", sid, conn_id)

    def _find_idle_connection(self) -> ExtensionConnection | None:
        """Find a connection not currently assigned to any session."""
        assigned = {info.ext_id for info in self._session_table.values()}
        for cid, conn in self._connections.items():
            if cid not in assigned and not conn.is_disconnected:
                return conn
        return None

    def resolve_session(self, session_id: str, client_ip: str) -> SessionInfo:
        """Find or create a session→extension mapping. Raises RuntimeError if no extension available."""
        if session_id in self._session_table:
            info = self._session_table[session_id]
            info.last_active = time.time()
            return info
        idle = self._find_idle_connection()
        if idle is None:
            raise RuntimeError("No available extensions")
        info = SessionInfo(ext_id=idle.connection_id, client_ip=client_ip, last_active=time.time())
        self._session_table[session_id] = info
        idle.session_id = session_id
        logger.info("Session %s assigned to extension %d", session_id, idle.connection_id)
        return info

    def update_chat_context(self, session_id: str, ctx: ChatContext | None) -> None:
        if session_id in self._session_table:
            self._session_table[session_id].chat_context = ctx
            self._session_table[session_id].last_active = time.time()

    def release_session(self, session_id: str) -> None:
        info = self._session_table.pop(session_id, None)
        if info and info.ext_id in self._connections:
            self._connections[info.ext_id].session_id = None
            logger.debug("Released session %s from extension %d", session_id, info.ext_id)

    async def send_to_session(self, session_id: str, data: dict[str, Any]) -> None:
        info = self._session_table.get(session_id)
        if not info:
            raise RuntimeError(f"Session {session_id} not found")
        conn = self._connections.get(info.ext_id)
        if not conn or conn.is_disconnected:
            self.release_session(session_id)
            raise RuntimeError(f"Extension for session {session_id} disconnected")
        await conn.send_json(data)

    async def receive_from_session(self, session_id: str, timeout: float = 150.0) -> dict[str, Any]:
        info = self._session_table.get(session_id)
        if not info:
            raise RuntimeError(f"Session {session_id} not found")
        conn = self._connections.get(info.ext_id)
        if not conn or conn.is_disconnected:
            self.release_session(session_id)
            raise RuntimeError(f"Extension for session {session_id} disconnected")
        try:
            return await asyncio.wait_for(conn.queue.get(), timeout=timeout)
        except asyncio.TimeoutError:
            self.release_session(session_id)
            raise

    def get_health(self) -> dict[str, Any]:
        return {
            "extensions_connected": self.connected_count,
            "sessions_active": self.session_count,
        }


pool = ConnectionPool()
```

- [ ] **Step 2: Verify syntax**

```bash
uv run python -c "from proxy_server.server.ws_manager import pool; print('OK, pool:', type(pool).__name__)"
```
Expected: `OK, pool: ConnectionPool`

- [ ] **Step 3: Commit**

```bash
git add proxy_server/server/ws_manager.py
git commit -m "feat(proxy): add ConnectionPool for multi-extension support"
```

---

### Task 3: Update api.py — Session Resolution and Chat Context Routing

**Files:**
- Modify: `proxy_server/server/api.py`

**Interfaces:**
- Consumes: `pool` from `ws_manager.py` (ConnectionPool singleton), `ChatContext` dataclass
- Produces: Updated `/health`, `/ws`, `/v1/chat/completions` endpoints

- [ ] **Step 1: Update imports**

Replace `from proxy_server.server.ws_manager import manager` with:

```python
from proxy_server.server.ws_manager import pool, ChatContext
```

- [ ] **Step 2: Add session resolution helper**

Add before `create_app`:

```python
def _resolve_session_id(request: Request) -> str:
    session_id = request.headers.get("X-Session-ID")
    if not session_id:
        session_id = f"ip:{request.client.host}"
    return session_id
```

- [ ] **Step 3: Update health endpoint**

Replace the `manager.is_connected` usage:

```python
@app.get("/health")
async def health():
    info = pool.get_health()
    return {
        "status": "ok",
        **info,
        "api_key": config.api_key,
    }
```

- [ ] **Step 4: Update websocket endpoint**

Replace `await manager.connect(websocket)` with:

```python
await pool.connect(websocket)
```

- [ ] **Step 5: Update chat_completions handler**

Replace the entire handler body with session-aware logic:

```python
@app.post("/v1/chat/completions")
async def chat_completions(request: Request):
    session_id = _resolve_session_id(request)

    try:
        session = pool.resolve_session(session_id, request.client.host)
    except RuntimeError:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="No available browser extension. Open chat.qwen.ai and ensure at least one tab has the extension active.",
        )

    body = await request.json()
    messages = body.get("messages", [])
    stream = body.get("stream", False)
    tools = body.get("tools", [])

    logger.info("Received chat request: session=%s messages=%d stream=%s",
                 session_id, len(messages), stream)

    try:
        parse_openai_messages(messages)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))

    request_id = str(uuid.uuid4())

    # Build execute message with chat context
    execute_msg: dict = {
        "type": "execute",
        "id": request_id,
        "messages": messages,
        "chat_context": asdict(session.chat_context) if session.chat_context else {
            "chatId": None,
            "parentId": None,
            "systemPrompt": None,
        },
    }
    if tools:
        execute_msg["tools"] = tools

    if stream:
        return StreamingResponse(
            _stream_response(session_id, request_id, execute_msg),
            media_type="text/event-stream",
            headers={
                "Cache-Control": "no-cache",
                "Connection": "keep-alive",
                "X-Accel-Buffering": "no",
            },
        )
    else:
        try:
            full_content, reasoning_content, tool_calls = await _execute_non_streaming(
                session_id, request_id, execute_msg,
            )
            return create_chat_completion_response(
                full_content, reasoning_content=reasoning_content, tool_calls=tool_calls,
            )
        except asyncio.TimeoutError:
            pool.release_session(session_id)
            raise HTTPException(
                status_code=status.HTTP_408_REQUEST_TIMEOUT,
                detail="Request timeout",
            )
        except Exception as e:
            pool.release_session(session_id)
            logger.exception("Non-streaming request failed")
            raise HTTPException(status_code=502, detail=str(e))
```

- [ ] **Step 6: Update _execute_non_streaming**

Replace the function signature and body to accept `session_id` and `execute_msg`:

```python
async def _execute_non_streaming(
    session_id: str,
    request_id: str,
    execute_msg: dict,
) -> tuple[str, str | None, list | None]:
    await pool.send_to_session(session_id, execute_msg)

    full_content = ""
    reasoning_content: str | None = None
    tool_calls: list | None = None
    timeout = REQUEST_TIMEOUT

    while True:
        try:
            resp = await pool.receive_from_session(session_id, timeout=timeout)
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

        elif msg_type == "tool_calls":
            tool_calls = resp.get("tool_calls", [])
            timeout = 30.0

        elif msg_type == "done":
            # Update chat context from response
            ctx_data = resp.get("chat_context")
            if ctx_data:
                pool.update_chat_context(session_id, ChatContext(**ctx_data))
            break

        elif msg_type == "error":
            error_msg = resp.get("error", {}).get("message", "Unknown error")
            raise RuntimeError(error_msg)

    return full_content, reasoning_content, tool_calls
```

- [ ] **Step 7: Update _stream_response**

Replace the function signature and body:

```python
async def _stream_response(
    session_id: str,
    request_id: str,
    execute_msg: dict,
) -> AsyncGenerator[str, None]:
    await pool.send_to_session(session_id, execute_msg)
    timeout = REQUEST_TIMEOUT

    try:
        while True:
            try:
                resp = await pool.receive_from_session(session_id, timeout=timeout)
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

            elif msg_type == "tool_calls":
                tool_calls = resp.get("tool_calls", [])
                yield create_chat_chunk("", tool_calls=tool_calls)
                timeout = 30.0

            elif msg_type == "done":
                ctx_data = resp.get("chat_context")
                if ctx_data:
                    pool.update_chat_context(session_id, ChatContext(**ctx_data))
                yield create_chat_chunk("", finish_reason="stop")
                yield create_done_signal()
                return

            elif msg_type == "error":
                error_msg = resp.get("error", {}).get("message", "Unknown error")
                yield create_chat_chunk(f"[Error: {error_msg}]", finish_reason="error")
                yield create_done_signal()
                return

    except Exception as e:
        logger.exception("Streaming error")
        yield create_chat_chunk("", finish_reason="error")
        yield create_done_signal()
```

- [ ] **Step 8: Verify syntax**

```bash
uv run python -c "from proxy_server.server.api import create_app; print('OK')"
```
Expected: `OK`

- [ ] **Step 9: Commit**

```bash
git add proxy_server/server/api.py
git commit -m "feat(proxy): add session resolution and chat_context routing"
```

---

### Task 4: Update Content Script — Stateless Execute Handling

**Files:**
- Modify: `browser-extension/src/content_script.ts`

**Interfaces:**
- Consumes: `ChatContext` from `types.ts`, updated `ExecuteMessage`/`DoneMessage` types
- Produces: Stateless content script that reads/writes `chat_context` from execute/done messages

- [ ] **Step 1: Remove module-level state variables**

Delete these three lines from `browser-extension/src/content_script.ts`:

```typescript
let currentChatId: string | null = null;
let currentParentId: string | null = null;
let cachedSystemPrompt: string | null = null;
```

- [ ] **Step 2: Update the execute handler — read chat_context, use local vars**

Find the execute handler inside `bridge.onMessage(async (msg: any) => {` and replace the module-variable reads. After the line `const lastUserMessage = msg.messages?.filter...`, add:

```typescript
// Read chat context from execute message (proxy-managed session state)
const ctx = msg.chat_context || {};
let chatId: string | null = ctx.chatId || null;
let parentId: string | null = ctx.parentId || null;
let systemPrompt: string | null = ctx.systemPrompt || null;
```

Then replace all references:
- `currentChatId` → `chatId`
- `currentParentId` → `parentId`
- `cachedSystemPrompt` → `systemPrompt`

- [ ] **Step 3: Update command handlers to use local state**

In the `/new` handler, replace:

```typescript
currentChatId = chatId;
currentParentId = null;
cachedSystemPrompt = null;
```
with:
```typescript
chatId = newChatId;
parentId = null;
systemPrompt = null;
```

And update the done message to include chat_context:

```typescript
bridge.send({
  type: "done",
  id: msg.id,
  usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  chat_context: { chatId, parentId: null, systemPrompt: null },
});
```

In the `/change` handler, replace `currentChatId = newChatId; currentParentId = lastId; cachedSystemPrompt = null;` with `chatId = newChatId; parentId = lastId; systemPrompt = null;` and include chat_context in the done response.

In the `/viewid` handler, replace `currentChatId` with `chatId` and include chat_context in the response.

- [ ] **Step 4: Update the normal message flow — include chat_context in done**

Find all places where `bridge.send({ type: "done", ... })` is called after a normal message execution and add:

```typescript
chat_context: { chatId, parentId, systemPrompt },
```

- [ ] **Step 5: Update the Cherry Studio split-request handling**

Find the system-only execute handler block (checking `!lastUserMessage`). Replace:

```typescript
cachedSystemPrompt = systemContent;
```
with:
```typescript
systemPrompt = systemContent;
```

And update the done response to include `chat_context`:

```typescript
bridge.send({
  type: "done",
  id: msg.id,
  usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  chat_context: { chatId, parentId, systemPrompt },
});
```

- [ ] **Step 6: Verify TypeScript**

```bash
cd browser-extension && npx tsc --noEmit
```
Expected: No type errors.

- [ ] **Step 7: Commit**

```bash
git add browser-extension/src/content_script.ts
git commit -m "feat(ext): stateless content script with chat_context passing"
```

---

### Task 5: Integration Verification

- [ ] **Step 1: Start the proxy**

```bash
uv run python -m proxy_server --log-level debug
```

- [ ] **Step 2: Build extension**

```bash
cd browser-extension && npm run build
```
Expected: Both content script (IIFE) and main (ES modules) build successfully.

- [ ] **Step 3: Manual smoke test (single extension)**

1. Load the extension in Chrome
2. Open chat.qwen.ai
3. Verify `/health` returns `extensions_connected: 1`
4. Send a chat completion via curl
5. Verify response is received correctly

- [ ] **Step 4: Manual multi-extension test**

1. Open a second tab on chat.qwen.ai (should auto-connect a second extension)
2. Verify `/health` returns `extensions_connected: 2`
3. Open a third tab — verify `extensions_connected: 3`
4. Send a chat completion with `X-Session-ID: test-session-1`
5. Send another with `X-Session-ID: test-session-2`
6. Both should complete successfully

- [ ] **Step 5: Manual session affinity test**

1. Send `X-Session-ID: test-affinity` with "Hello"
2. Send `X-Session-ID: test-affinity` with "What did I just say?"
3. Verify the second request knows the context of the first (multi-turn works)

- [ ] **Step 6: Manual IP fallback test**

1. Send a request WITHOUT `X-Session-ID` header
2. Send a second request from the same client IP
3. Verify both work (should fall back to IP-based session)

- [ ] **Step 7: Commit remaining changes**

```bash
git add -A
git commit -m "chore: multi-extension connection pool integration"
```
