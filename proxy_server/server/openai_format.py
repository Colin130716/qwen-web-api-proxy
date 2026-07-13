from __future__ import annotations

import json
import logging
import secrets
import time
from typing import Any

logger = logging.getLogger(__name__)

# ── Model Catalog ──────────────────────────────────────────────
# Derived from GET /api/v2/models responses. Each model carries its
# capabilities so the proxy can validate features like vision.
#
# The `qwen-web` and `qwen-web-vision` aliases are kept for backward
# compatibility; they resolve to the default model.

MODEL_ALIASES: dict[str, str] = {
    "qwen-web": "qwen3.7-plus",
    "qwen-web-vision": "qwen3.7-plus",
}

ModelMeta = dict[str, Any]

MODEL_CATALOG: dict[str, ModelMeta] = {
    "qwen3.7-plus": {
        "description": "Qwen3.7-Plus — high-performance LLM with text & multimodal support",
        "vision": True,
        "thinking": True,
        "search": True,
        "modality": ["text", "image", "video"],
    },
    "qwen3.7-max": {
        "description": "Qwen3.7-Max — flagship model, text-only, best at complex reasoning & coding",
        "vision": False,
        "thinking": True,
        "search": True,
        "modality": ["text"],
    },
    "qwen3.6-plus": {
        "description": "Qwen3.6-Plus — latest text & multimodal model",
        "vision": True,
        "thinking": True,
        "search": True,
        "modality": ["text", "image", "video"],
    },
    "qwen3.6-max-preview": {
        "description": "Qwen3.6-Max-Preview — flagship preview, text-only, no search",
        "vision": False,
        "thinking": True,
        "search": False,
        "modality": ["text"],
    },
    "qwen3.6-27b": {
        "description": "Qwen3.6-27B — dense model optimized for local deployment",
        "vision": True,
        "thinking": True,
        "search": False,
        "modality": ["text", "image", "video"],
    },
    "qwen3.5-plus": {
        "description": "Qwen3.5-Plus — text & multimodal with tool calling",
        "vision": True,
        "thinking": True,
        "search": True,
        "modality": ["text", "image", "video"],
    },
    "qwen3.5-omni-plus": {
        "description": "Qwen3.5-Omni-Plus — native full-modal model (text/image/audio/video)",
        "vision": True,
        "thinking": False,
        "search": True,
        "modality": ["text", "image", "video", "audio"],
    },
    "qwen3.6-35b-a3b": {
        "description": "Qwen3.6-35B-A3B — efficient MoE model with vision & thinking",
        "vision": True,
        "thinking": True,
        "search": True,
        "modality": ["text", "image", "video"],
    },
    "qwen3.5-flash": {
        "description": "Qwen3.5-Flash — efficient model, text & multimodal",
        "vision": True,
        "thinking": True,
        "search": True,
        "modality": ["text", "image", "video"],
    },
    "qwen3.5-max-2026-03-08": {
        "description": "Qwen3.5-Max-Preview — text-only flagship preview, thinking-only mode",
        "vision": False,
        "thinking": True,
        "search": False,
        "modality": ["text"],
    },
    "qwen3.5-397b-a17b": {
        "description": "Qwen3.5-397B-A17B — open-source flagship MoE, text & multimodal",
        "vision": True,
        "thinking": True,
        "search": True,
        "modality": ["text", "image", "video"],
    },
    "qwen3.5-omni-flash": {
        "description": "Qwen3.5-Omni-Flash — efficient full-modal model",
        "vision": True,
        "thinking": False,
        "search": True,
        "modality": ["text", "image", "video", "audio"],
    },
    "qwen3-max-2026-01-23": {
        "description": "Qwen3-Max — language model, vision+thinking+search",
        "vision": True,
        "thinking": True,
        "search": True,
        "modality": ["text"],
    },
    "qwen-plus-2025-07-28": {
        "description": "Qwen3-235B-A22B-2507 — MoE flagship with dynamic thinking budget",
        "vision": True,
        "thinking": True,
        "search": False,
        "modality": ["text"],
    },
    "qwen3-coder-plus": {
        "description": "Qwen3-Coder — coding-specialized model, 1M context",
        "vision": True,
        "thinking": True,
        "search": False,
        "modality": ["text"],
    },
    "qwen3-vl-plus": {
        "description": "Qwen3-VL-235B-A22B — vision-language model, 256K context",
        "vision": True,
        "thinking": True,
        "search": False,
        "modality": ["text", "image", "video"],
    },
    "qwen3-omni-flash-2025-12-01": {
        "description": "Qwen3-Omni-Flash — native full-modal model",
        "vision": True,
        "thinking": True,
        "search": False,
        "modality": ["text", "image", "video", "audio"],
    },
}


def resolve_model(model_id: str) -> str:
    """Resolve alias → canonical Qwen model ID; passthrough if already canonical."""
    return MODEL_ALIASES.get(model_id, model_id)


def get_model_meta(model_id: str) -> ModelMeta | None:
    """Return metadata for a model ID (after alias resolution), or None if unknown."""
    canonical = resolve_model(model_id)
    return MODEL_CATALOG.get(canonical)


def model_supports_vision(model_id: str) -> bool:
    meta = get_model_meta(model_id)
    return bool(meta and meta.get("vision"))


def _generate_id() -> str:
    return f"chatcmpl-qwen-{secrets.token_hex(8)}"


def create_chat_completion_response(
    content: str,
    model: str = "qwen3.7-plus",
    prompt_tokens: int = 0,
    completion_tokens: int = 0,
    reasoning_content: str | None = None,
    tool_calls: list[dict] | None = None,
) -> dict[str, Any]:
    """Create a non-streaming OpenAI Chat Completions response."""
    has_tool_calls = bool(tool_calls)
    message: dict[str, Any] = {
        "role": "assistant",
        "content": content if not has_tool_calls else None,
    }
    if reasoning_content:
        message["reasoning_content"] = reasoning_content
    if has_tool_calls:
        message["tool_calls"] = tool_calls
    return {
        "id": _generate_id(),
        "object": "chat.completion",
        "created": int(time.time()),
        "model": model,
        "choices": [
            {
                "index": 0,
                "message": message,
                "finish_reason": "tool_calls" if has_tool_calls else "stop",
                "logprobs": None,
            }
        ],
        "usage": {
            "prompt_tokens": prompt_tokens or estimate_token_count(""),
            "completion_tokens": completion_tokens or estimate_token_count(content),
            "total_tokens": (prompt_tokens or 0) + (completion_tokens or 0),
        },
        "system_fingerprint": "fp_qwen_proxy",
    }


def create_chat_chunk(
    content: str,
    model: str = "qwen3.7-plus",
    finish_reason: str | None = None,
    reasoning_content: str | None = None,
    tool_calls: list[dict] | None = None,
) -> str:
    """Create a streaming SSE data line for a single content chunk."""
    delta: dict[str, Any] = {}
    if reasoning_content:
        delta["reasoning_content"] = reasoning_content
    if content:
        delta["content"] = content
    if tool_calls:
        delta["tool_calls"] = tool_calls
    chunk: dict[str, Any] = {
        "id": _generate_id(),
        "object": "chat.completion.chunk",
        "created": int(time.time()),
        "model": model,
        "choices": [
            {
                "index": 0,
                "delta": delta,
                "finish_reason": finish_reason if finish_reason else ("tool_calls" if tool_calls else None),
                "logprobs": None,
            }
        ],
        "system_fingerprint": "fp_qwen_proxy",
    }
    return f"data: {json.dumps(chunk)}\n\n"


def create_done_signal() -> str:
    """Create the SSE stream termination signal."""
    return "data: [DONE]\n\n"


def create_models_response() -> dict[str, Any]:
    """Create a GET /v1/models response with all known Qwen models + aliases."""
    now = int(time.time())
    models: list[dict[str, Any]] = []

    # Backward-compatible aliases
    for alias, target in MODEL_ALIASES.items():
        meta = MODEL_CATALOG.get(target, {})
        models.append({
            "id": alias,
            "object": "model",
            "created": now,
            "owned_by": "qwen-web-api-proxy",
            "description": f"Alias for {target} — {meta.get('description', '')}",
        })

    # Canonical models from catalog
    for mid, meta in MODEL_CATALOG.items():
        models.append({
            "id": mid,
            "object": "model",
            "created": now,
            "owned_by": "qwen",
            "description": meta.get("description", ""),
            "capabilities": {
                "vision": meta.get("vision", False),
                "thinking": meta.get("thinking", False),
                "search": meta.get("search", False),
            },
        })

    return {"object": "list", "data": models}


def estimate_token_count(text: str) -> int:
    """Rough token estimate: ~4 chars per token for mixed text."""
    return max(1, len(text) // 4)


def _validate_content(content: Any) -> None:
    """Validate a message content field — string or multimodal array."""
    if isinstance(content, str):
        return
    if isinstance(content, list):
        for part in content:
            if not isinstance(part, dict) or "type" not in part:
                raise ValueError(f"Invalid content part: {part}")
            if part["type"] == "text" and "text" not in part:
                raise ValueError(f"Text content part missing 'text': {part}")
            if part["type"] == "image_url":
                url = part.get("image_url", {}).get("url", "")
                if not url.startswith("data:image/"):
                    raise ValueError(f"image_url must be data URI, got: {url[:50]}")
        return
    raise ValueError(f"Content must be string or array, got {type(content).__name__}")


def parse_openai_messages(messages: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Validate and normalize OpenAI messages (supports multimodal content arrays)."""
    required_roles = {"system", "user", "assistant", "tool"}
    for msg in messages:
        if "role" not in msg:
            raise ValueError(f"Invalid message format: {msg}")
        if msg["role"] not in required_roles:
            raise ValueError(f"Unknown role: {msg['role']}")
        if msg["role"] == "assistant" and "tool_calls" not in msg and "content" not in msg:
            raise ValueError(f"Assistant message must have 'content' or 'tool_calls': {msg}")
        if msg["role"] != "assistant" and "content" not in msg:
            raise ValueError(f"Invalid message format: {msg}")
        if "content" in msg and msg["content"] is not None:
            _validate_content(msg["content"])
    return messages
