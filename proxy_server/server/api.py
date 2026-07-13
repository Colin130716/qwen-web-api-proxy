from __future__ import annotations

import asyncio
import json
import logging
import uuid
from dataclasses import asdict
from typing import AsyncGenerator

import secrets

from fastapi import FastAPI, HTTPException, WebSocket, Request, status
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse

from proxy_server.config import ProxyConfig
from proxy_server.server.auth import verify_api_key
from proxy_server.server.ws_manager import pool, ChatContext
from proxy_server.server.openai_format import (
    create_chat_completion_response,
    create_chat_chunk,
    create_done_signal,
    create_models_response,
    parse_openai_messages,
    resolve_model,
    get_model_meta,
)
from proxy_server.server.response_formats import (
    AnthropicFormatter,
    OpenAIResponsesFormatter,
    parse_anthropic_messages,
    parse_openai_responses,
)

logger = logging.getLogger(__name__)

REQUEST_TIMEOUT = 150.0  # seconds


def _require_auth(request: Request, config: ProxyConfig) -> None:
    verify_api_key(request, config)


def _resolve_session_id(request: Request) -> str:
    session_id = request.headers.get("X-Session-ID")
    if not session_id:
        session_id = f"ip:{request.client.host}"
    return session_id


def create_app(config: ProxyConfig) -> FastAPI:
    app = FastAPI(title="Qwen Web API Proxy", version="1.0.0")

    # CORS: allow extension origins + common dev tools
    # chrome-extension://* is invalid — use regex for dynamic extension IDs
    # WebSocket connections are not subject to CORS, so this only affects
    # the popup's /health fetch and similar extension-origin HTTP requests.
    app.add_middleware(
        CORSMiddleware,
        allow_origins=[
            "http://localhost:11434",
            "http://127.0.0.1:11434",
            "http://localhost:8080",
        ],
        allow_origin_regex=r"chrome-extension://.*",
        allow_methods=["*"],
        allow_headers=["*"],
    )

    # ── Health check (no auth) ──────────────────────────────
    @app.get("/health")
    async def health():
        info = pool.get_health()
        return {
            "status": "ok",
            **info,
            "api_key": config.api_key,
        }

    # ── List models ─────────────────────────────────────────
    @app.get("/v1/models")
    async def list_models(request: Request):
        _require_auth(request, config)
        return create_models_response()

    # ── Chat completions ────────────────────────────────────
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
        model = resolve_model(body.get("model", "qwen3.7-plus"))

        logger.info("Received chat request: session=%s model=%s messages=%d stream=%s",
                     session_id, model, len(messages), stream)

        try:
            parse_openai_messages(messages)
        except ValueError as e:
            raise HTTPException(status_code=400, detail=str(e))

        # Warn if user picks a model that can't support the request
        model_meta = get_model_meta(model)
        has_images = any(
            isinstance(m.get("content"), list)
            for m in messages
        )
        if has_images and model_meta and not model_meta.get("vision"):
            logger.warning("Model %s does not support vision but content contains images; "
                          "consider using a vision-capable model (e.g. qwen3.7-plus)", model)

        request_id = str(uuid.uuid4())

        # Build execute message with chat context and model
        execute_msg: dict = {
            "type": "execute",
            "id": request_id,
            "model": model,
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
                _stream_response(session_id, request_id, execute_msg, model),
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
                    session_id, request_id, execute_msg, model,
                )
                return create_chat_completion_response(
                    full_content, model=model, reasoning_content=reasoning_content, tool_calls=tool_calls,
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

    # ── Anthropic Messages API ──────────────────────────────
    @app.post("/v1/messages")
    async def anthropic_messages(request: Request):
        session_id = _resolve_session_id(request)

        try:
            session = pool.resolve_session(session_id, request.client.host)
        except RuntimeError:
            raise HTTPException(
                status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                detail="No available browser extension.",
            )

        body = await request.json()
        parsed = parse_anthropic_messages(body)
        messages = parsed["messages"]
        model = resolve_model(parsed["model"])
        stream = parsed["stream"]
        tools = parsed["tools"]

        logger.info("Received Anthropic request: session=%s model=%s messages=%d stream=%s",
                     session_id, model, len(messages), stream)

        try:
            parse_openai_messages(messages)
        except ValueError as e:
            raise HTTPException(status_code=400, detail=str(e))

        request_id = str(uuid.uuid4())
        execute_msg: dict = {
            "type": "execute",
            "id": request_id,
            "model": model,
            "messages": messages,
            "chat_context": asdict(session.chat_context) if session.chat_context else {
                "chatId": None, "parentId": None, "systemPrompt": None,
            },
        }
        if tools:
            execute_msg["tools"] = tools

        if stream:
            return StreamingResponse(
                _stream_anthropic(session_id, request_id, execute_msg, model),
                media_type="text/event-stream",
                headers={
                    "Cache-Control": "no-cache",
                    "Connection": "keep-alive",
                    "X-Accel-Buffering": "no",
                },
            )
        else:
            try:
                full_content, reasoning_content, _ = await _execute_non_streaming(
                    session_id, request_id, execute_msg, model,
                )
                formatter = AnthropicFormatter(model)
                return formatter.non_streaming_response(full_content, reasoning=reasoning_content)
            except asyncio.TimeoutError:
                pool.release_session(session_id)
                raise HTTPException(status_code=408, detail="Request timeout")
            except Exception as e:
                pool.release_session(session_id)
                logger.exception("Anthropic non-streaming request failed")
                raise HTTPException(status_code=502, detail=str(e))

    # ── OpenAI Responses API ─────────────────────────────────
    @app.post("/v1/responses")
    async def openai_responses(request: Request):
        session_id = _resolve_session_id(request)

        try:
            session = pool.resolve_session(session_id, request.client.host)
        except RuntimeError:
            raise HTTPException(
                status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                detail="No available browser extension.",
            )

        body = await request.json()
        parsed = parse_openai_responses(body)
        messages = parsed["messages"]
        model = resolve_model(parsed["model"])
        stream = parsed["stream"]
        tools = parsed["tools"]

        logger.info("Received OpenAI Responses request: session=%s model=%s messages=%d stream=%s",
                     session_id, model, len(messages), stream)

        try:
            parse_openai_messages(messages)
        except ValueError as e:
            raise HTTPException(status_code=400, detail=str(e))

        request_id = str(uuid.uuid4())
        execute_msg: dict = {
            "type": "execute",
            "id": request_id,
            "model": model,
            "messages": messages,
            "chat_context": asdict(session.chat_context) if session.chat_context else {
                "chatId": None, "parentId": None, "systemPrompt": None,
            },
        }
        if tools:
            execute_msg["tools"] = tools

        if stream:
            return StreamingResponse(
                _stream_openai_responses(session_id, request_id, execute_msg, model),
                media_type="text/event-stream",
                headers={
                    "Cache-Control": "no-cache",
                    "Connection": "keep-alive",
                    "X-Accel-Buffering": "no",
                },
            )
        else:
            try:
                full_content, reasoning_content, _ = await _execute_non_streaming(
                    session_id, request_id, execute_msg, model,
                )
                formatter = OpenAIResponsesFormatter(model)
                return formatter.non_streaming_response(full_content, reasoning=reasoning_content)
            except asyncio.TimeoutError:
                pool.release_session(session_id)
                raise HTTPException(status_code=408, detail="Request timeout")
            except Exception as e:
                pool.release_session(session_id)
                logger.exception("OpenAI Responses non-streaming request failed")
                raise HTTPException(status_code=502, detail=str(e))

    # ── WebSocket for extension bridge ──────────────────────
    @app.websocket("/ws")
    async def websocket_endpoint(websocket: WebSocket):
        # Authenticate via api_key query parameter
        api_key_param = websocket.query_params.get("api_key", "")
        if not api_key_param or not secrets.compare_digest(api_key_param, config.api_key):
            await websocket.close(code=4001, reason="Invalid API key")
            return
        await pool.connect(websocket)

    return app


async def _execute_non_streaming(
    session_id: str,
    request_id: str,
    execute_msg: dict,
    model: str = "qwen3.7-plus",
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
            ctx_data = resp.get("chat_context")
            if ctx_data:
                pool.update_chat_context(session_id, ChatContext(**ctx_data))
            break

        elif msg_type == "error":
            error_msg = resp.get("error", {}).get("message", "Unknown error")
            raise RuntimeError(error_msg)

    return full_content, reasoning_content, tool_calls


async def _stream_response(
    session_id: str,
    request_id: str,
    execute_msg: dict,
    model: str = "qwen3.7-plus",
) -> AsyncGenerator[str, None]:
    execute_msg.setdefault("options", {})["stream"] = True
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
                yield create_chat_chunk(
                    "", model=model, reasoning_content=resp.get("content", "")
                )
                timeout = 30.0

            elif msg_type == "chunk":
                content = resp.get("data", {}).get("content", "")
                yield create_chat_chunk(content, model=model)
                timeout = 30.0

            elif msg_type == "tool_calls":
                tool_calls = resp.get("tool_calls", [])
                yield create_chat_chunk("", model=model, tool_calls=tool_calls)
                timeout = 30.0

            elif msg_type == "done":
                ctx_data = resp.get("chat_context")
                if ctx_data:
                    pool.update_chat_context(session_id, ChatContext(**ctx_data))
                yield create_chat_chunk("", model=model, finish_reason="stop")
                yield create_done_signal()
                return

            elif msg_type == "error":
                error_msg = resp.get("error", {}).get("message", "Unknown error")
                yield create_chat_chunk(
                    f"[Error: {error_msg}]", model=model, finish_reason="error"
                )
                yield create_done_signal()
                return

    except Exception as e:
        logger.exception("Streaming error")
        yield create_chat_chunk("", model=model, finish_reason="error")
        yield create_done_signal()


async def _stream_anthropic(
    session_id: str,
    request_id: str,
    execute_msg: dict,
    model: str = "qwen3.7-plus",
) -> AsyncGenerator[str, None]:
    """Streaming handler for Anthropic Messages format (/v1/messages)."""
    execute_msg.setdefault("options", {})["stream"] = True
    await pool.send_to_session(session_id, execute_msg)

    fmt = AnthropicFormatter(model)
    yield fmt.message_start()
    timeout = REQUEST_TIMEOUT

    try:
        while True:
            try:
                resp = await pool.receive_from_session(session_id, timeout=timeout)
            except asyncio.TimeoutError:
                for event in fmt.error("Request timeout"):
                    yield event
                return

            msg_type = resp.get("type")

            if msg_type == "reasoning":
                content = resp.get("content", "")
                for event in fmt.reasoning(content):
                    yield event
                timeout = 30.0

            elif msg_type == "chunk":
                content = resp.get("data", {}).get("content", "")
                for event in fmt.content(content):
                    yield event
                timeout = 30.0

            elif msg_type == "done":
                ctx_data = resp.get("chat_context")
                if ctx_data:
                    pool.update_chat_context(session_id, ChatContext(**ctx_data))
                for event in fmt.done():
                    yield event
                return

            elif msg_type == "error":
                error_msg = resp.get("error", {}).get("message", "Unknown error")
                for event in fmt.error(error_msg):
                    yield event
                return

    except Exception as e:
        logger.exception("Anthropic streaming error")
        for event in fmt.error(str(e)):
            yield event


async def _stream_openai_responses(
    session_id: str,
    request_id: str,
    execute_msg: dict,
    model: str = "qwen3.7-plus",
) -> AsyncGenerator[str, None]:
    """Streaming handler for OpenAI Responses API format (/v1/responses)."""
    execute_msg.setdefault("options", {})["stream"] = True
    await pool.send_to_session(session_id, execute_msg)

    fmt = OpenAIResponsesFormatter(model)
    yield fmt.response_start()
    timeout = REQUEST_TIMEOUT

    try:
        while True:
            try:
                resp = await pool.receive_from_session(session_id, timeout=timeout)
            except asyncio.TimeoutError:
                yield fmt.error("Request timeout")
                yield fmt.done_signal()
                return

            msg_type = resp.get("type")

            if msg_type == "reasoning":
                content = resp.get("content", "")
                for event in fmt.reasoning(content):
                    yield event
                timeout = 30.0

            elif msg_type == "chunk":
                content = resp.get("data", {}).get("content", "")
                for event in fmt.content(content):
                    yield event
                timeout = 30.0

            elif msg_type == "done":
                ctx_data = resp.get("chat_context")
                if ctx_data:
                    pool.update_chat_context(session_id, ChatContext(**ctx_data))
                yield fmt.done()
                yield fmt.done_signal()
                return

            elif msg_type == "error":
                error_msg = resp.get("error", {}).get("message", "Unknown error")
                yield fmt.error(error_msg)
                yield fmt.done_signal()
                return

    except Exception as e:
        logger.exception("OpenAI Responses streaming error")
        yield fmt.error(str(e))
        yield fmt.done_signal()
