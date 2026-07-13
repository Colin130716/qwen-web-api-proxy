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
        self.session_id: str | None = None
        self._disconnected = False

    async def reader_loop(self) -> None:
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
        self._connections.pop(conn_id, None)
        evicted = [sid for sid, info in self._session_table.items() if info.ext_id == conn_id]
        for sid in evicted:
            del self._session_table[sid]
            logger.debug("Evicted session %s (extension %d disconnected)", sid, conn_id)

    def _find_idle_connection(self) -> ExtensionConnection | None:
        assigned = {info.ext_id for info in self._session_table.values()}
        for cid, conn in self._connections.items():
            if cid not in assigned and not conn.is_disconnected:
                return conn
        return None

    def resolve_session(self, session_id: str, client_ip: str) -> SessionInfo:
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
            "extension_connected": self.connected_count > 0,
            "extensions_connected": self.connected_count,
            "sessions_active": self.session_count,
        }


pool = ConnectionPool()
