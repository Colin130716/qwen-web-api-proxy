from __future__ import annotations

import json
import secrets
import time
from typing import Any, AsyncGenerator


def _generate_msg_id() -> str:
    return f"msg_qwen_{secrets.token_hex(8)}"

def _generate_resp_id() -> str:
    return f"resp_qwen_{secrets.token_hex(8)}"


# ── Anthropic Messages Format ──────────────────────────────────

class AnthropicFormatter:
    """Streaming SSE formatter for Anthropic Messages API.

    Produces Server-Sent Events matching the Anthropic streaming spec:
      message_start → content_block_start(thinking) → content_block_delta(thinking_delta)*
      → content_block_stop → content_block_start(text) → content_block_delta(text_delta)*
      → content_block_stop → message_delta → message_stop

    Non-streaming response is a single JSON body with content blocks.
    """

    def __init__(self, model: str):
        self.model = model
        self._msg_id = _generate_msg_id()
        self._thinking_block_idx: int | None = None
        self._text_block_idx: int | None = None
        self._thinking_started = False
        self._text_started = False
        self._thinking_done = False
        self._text_done = False
        self._total_input_tokens = 0
        self._total_output_tokens = 0

    # ── Streaming events ──

    def _sse(self, data: dict) -> str:
        return f"event: {data.get('type', '')}\ndata: {json.dumps(data)}\n\n"

    def message_start(self) -> str:
        return self._sse({
            "type": "message_start",
            "message": {
                "id": self._msg_id,
                "type": "message",
                "role": "assistant",
                "content": [],
                "model": self.model,
                "stop_reason": None,
                "stop_sequence": None,
                "usage": {"input_tokens": 0, "output_tokens": 0},
            },
        })

    def reasoning(self, content: str) -> list[str]:
        """Format a reasoning chunk. May emit content_block_start and stop as needed."""
        events: list[str] = []
        if not self._thinking_started:
            self._thinking_block_idx = 0
            self._text_block_idx = 1  # text follows thinking
            self._thinking_started = True
            events.append(self._sse({
                "type": "content_block_start",
                "index": self._thinking_block_idx,
                "content_block": {"type": "thinking", "thinking": ""},
            }))
        events.append(self._sse({
            "type": "content_block_delta",
            "index": self._thinking_block_idx,
            "delta": {"type": "thinking_delta", "thinking": content},
        }))
        return events

    def reasoning_finished(self) -> str:
        """Emit the thinking content_block_stop."""
        if self._thinking_started and not self._thinking_done:
            self._thinking_done = True
            return self._sse({
                "type": "content_block_stop",
                "index": self._thinking_block_idx,
            })
        return ""

    def content(self, text: str) -> list[str]:
        """Format a content (answer) chunk. Emits content_block_start on first call."""
        events: list[str] = []
        if self._thinking_started and not self._thinking_done:
            events.append(self.reasoning_finished())
        if not self._text_started:
            if self._text_block_idx is None:
                self._text_block_idx = 0
            self._text_started = True
            events.append(self._sse({
                "type": "content_block_start",
                "index": self._text_block_idx,
                "content_block": {"type": "text", "text": ""},
            }))
        events.append(self._sse({
            "type": "content_block_delta",
            "index": self._text_block_idx,
            "delta": {"type": "text_delta", "text": text},
        }))
        return events

    def message_delta(self, usage: dict | None = None) -> str:
        """Final message metadata (stop reason + usage)."""
        if self._text_started and not self._text_done:
            self._text_done = True
        if usage:
            self._total_input_tokens = usage.get("input_tokens", 0)
            self._total_output_tokens = usage.get("output_tokens", 0)
        return self._sse({
            "type": "message_delta",
            "delta": {
                "stop_reason": "end_turn",
                "stop_sequence": None,
            },
            "usage": {
                "input_tokens": self._total_input_tokens,
                "output_tokens": self._total_output_tokens,
            },
        })

    def message_stop(self) -> str:
        return self._sse({"type": "message_stop"})

    def done(self, usage: dict | None = None) -> list[str]:
        """Sequence: message_delta → message_stop."""
        events = [self.message_delta(usage), self.message_stop()]
        # Close any open content blocks
        result: list[str] = []
        if self._thinking_started and not self._thinking_done:
            result.append(self.reasoning_finished())
        if self._text_started and not self._text_done:
            self._text_done = True
            result.append(self._sse({
                "type": "content_block_stop",
                "index": self._text_block_idx,
            }))
        result.extend(events)
        return result

    def error(self, error_msg: str) -> list[str]:
        """Emit an Anthropic-compatible error event."""
        close_events: list[str] = []
        if self._thinking_started and not self._thinking_done:
            close_events.append(self.reasoning_finished())
        if self._text_started and not self._text_done:
            self._text_done = True
            close_events.append(self._sse({
                "type": "content_block_stop",
                "index": self._text_block_idx,
            }))
        close_events.append(self._sse({
            "type": "error",
            "error": {
                "type": "api_error",
                "message": error_msg,
            },
        }))
        return close_events

    # ── Non-streaming ──

    def non_streaming_response(
        self,
        content: str,
        reasoning: str | None = None,
        usage: dict | None = None,
    ) -> dict[str, Any]:
        """Build a complete non-streaming Anthropic Messages response."""
        content_blocks: list[dict[str, Any]] = []
        if reasoning:
            content_blocks.append({"type": "thinking", "thinking": reasoning})
        content_blocks.append({"type": "text", "text": content})

        return {
            "id": self._msg_id,
            "type": "message",
            "role": "assistant",
            "content": content_blocks,
            "model": self.model,
            "stop_reason": "end_turn",
            "stop_sequence": None,
            "usage": {
                "input_tokens": (usage or {}).get("input_tokens", 0),
                "output_tokens": (usage or {}).get("output_tokens", 0),
            },
        }

    def error_response(self, error_msg: str) -> dict[str, Any]:
        return {
            "type": "error",
            "error": {
                "type": "api_error",
                "message": error_msg,
            },
        }


# ── OpenAI Responses API Format ────────────────────────────────

class OpenAIResponsesFormatter:
    """Formatter for the OpenAI Responses API (v2)."""

    def __init__(self, model: str):
        self.model = model
        self._resp_id = _generate_resp_id()
        self._thinking_output_idx: int | None = None
        self._text_output_idx: int | None = None
        self._thinking_started = False
        self._text_started = False

    # ── Streaming events ──

    def _sse(self, data: dict) -> str:
        return f"data: {json.dumps(data)}\n\n"

    def response_start(self) -> str:
        return self._sse({
            "type": "response.output_item.added",
            "output_index": 0,
            "item": {
                "id": f"item_{secrets.token_hex(8)}",
                "type": "message",
                "status": "in_progress",
                "role": "assistant",
                "content": [],
            },
        })

    def reasoning(self, content: str) -> list[str]:
        """Emit a reasoning_content delta."""
        events: list[str] = []
        if not self._thinking_started:
            self._thinking_output_idx = 0
            self._thinking_started = True
            events.append(self._sse({
                "type": "response.output_text.delta",
                "output_index": 0,
                "content_index": 0,
                "delta": content,
            }))
        else:
            events.append(self._sse({
                "type": "response.output_text.delta",
                "output_index": 0,
                "content_index": 0,
                "delta": content,
            }))
        return events

    def content(self, text: str) -> list[str]:
        events: list[str] = []
        if not self._text_started:
            self._text_output_idx = (self._thinking_output_idx or 0) + 1 if self._thinking_started else 0
            self._text_started = True
            events.append(self._sse({
                "type": "response.output_text.delta",
                "output_index": 0,
                "content_index": self._text_output_idx,
                "delta": text,
            }))
        else:
            events.append(self._sse({
                "type": "response.output_text.delta",
                "output_index": 0,
                "content_index": self._text_output_idx,
                "delta": text,
            }))
        return events

    def done(self, usage: dict | None = None) -> str:
        return self._sse({
            "type": "response.completed",
            "response": {
                "id": self._resp_id,
                "object": "response",
                "model": self.model,
                "output": [],
                "usage": {
                    "input_tokens": (usage or {}).get("input_tokens", 0),
                    "output_tokens": (usage or {}).get("output_tokens", 0),
                },
            },
        })

    def error(self, error_msg: str) -> str:
        return self._sse({
            "type": "error",
            "error": {"message": error_msg},
        })

    def done_signal(self) -> str:
        return "data: [DONE]\n\n"

    # ── Non-streaming ──

    def non_streaming_response(
        self,
        content: str,
        reasoning: str | None = None,
        usage: dict | None = None,
    ) -> dict[str, Any]:
        """Build a complete non-streaming OpenAI Responses response."""
        output_content: list[dict[str, Any]] = []
        if reasoning:
            output_content.append({
                "type": "reasoning",
                "reasoning_content": reasoning,
            })
        output_content.append({
            "type": "message",
            "role": "assistant",
            "content": [{"type": "output_text", "text": content}],
        })

        return {
            "id": self._resp_id,
            "object": "response",
            "model": self.model,
            "created": int(time.time()),
            "output": output_content,
            "usage": {
                "input_tokens": (usage or {}).get("input_tokens", 0),
                "output_tokens": (usage or {}).get("output_tokens", 0),
            },
        }

    def error_response(self, error_msg: str) -> dict[str, Any]:
        return {"error": {"message": error_msg}}


# ── Anthropic Request Parsing ──────────────────────────────────

def parse_anthropic_messages(body: dict) -> dict:
    """Parse an Anthropic Messages API request into internal execute message format.

    Returns dict with keys: messages, model, stream, tools (extracted from body).
    """
    model: str = body.get("model", "qwen3.7-plus")
    stream: bool = body.get("stream", False)
    max_tokens: int = body.get("max_tokens", 4096)
    system: str | list | None = body.get("system")
    messages: list[dict] = body.get("messages", [])

    # Build internal messages array
    internal_messages: list[dict] = []

    # Anthropic system prompt → internal system message
    if system:
        if isinstance(system, str):
            internal_messages.append({"role": "system", "content": system})
        elif isinstance(system, list):
            # Anthropic allows system as list of {type: "text", text: "..."}
            texts = [
                block["text"] for block in system
                if isinstance(block, dict) and block.get("type") == "text"
            ]
            if texts:
                internal_messages.append({"role": "system", "content": "\n".join(texts)})

    # Anthropic assistant messages with thinking content blocks → reasoning
    for msg in messages:
        role = msg.get("role", "user")
        content = msg.get("content", "")

        if isinstance(content, str):
            internal_messages.append({"role": role, "content": content})
        elif isinstance(content, list):
            # Content blocks: extract text, image, tool_use, tool_result
            text_parts: list[str] = []
            image_parts: list[dict] = []
            for block in content:
                if not isinstance(block, dict):
                    continue
                btype = block.get("type", "")
                if btype == "text":
                    text_parts.append(block.get("text", ""))
                elif btype == "image":
                    source = block.get("source", {})
                    if source.get("type") == "base64":
                        media_type = source.get("media_type", "image/jpeg")
                        data = source.get("data", "")
                        image_parts.append({
                            "type": "image_url",
                            "image_url": {
                                "url": f"data:{media_type};base64,{data}",
                            },
                        })
                elif btype == "tool_use":
                    # tool_use blocks typically appear in assistant messages
                    # We strip them since the Qwen API handles tool calls differently
                    pass
                elif btype == "tool_result":
                    # tool_result blocks appear in user messages
                    if "content" in block:
                        result_content = block["content"]
                        if isinstance(result_content, str):
                            text_parts.append(f"[Tool result: {result_content}]")
                        elif isinstance(result_content, list):
                            for rc in result_content:
                                if isinstance(rc, dict) and rc.get("type") == "text":
                                    text_parts.append(f"[Tool result: {rc.get('text', '')}]")
                elif btype == "thinking" or btype == "redacted_thinking":
                    # Skip thinking blocks from Anthropic → just ignore
                    pass

            combined: str | list = "\n".join(text_parts) if text_parts else ""
            if image_parts:
                content_array: list[dict] = []
                if combined:
                    content_array.append({"type": "text", "text": combined})
                content_array.extend(image_parts)
                internal_messages.append({"role": role, "content": content_array})
            else:
                internal_messages.append({"role": role, "content": combined})

    # Extract tools if present
    internal_tools = body.get("tools", [])

    return {
        "messages": internal_messages,
        "model": model,
        "stream": stream,
        "tools": internal_tools,
    }


# ── OpenAI Responses Request Parsing ───────────────────────────

def parse_openai_responses(body: dict) -> dict:
    """Parse an OpenAI Responses API request into internal execute message format."""
    model: str = body.get("model", "qwen3.7-plus")
    stream: bool = body.get("stream", False)
    input_data = body.get("input", "")

    internal_messages: list[dict] = []

    if isinstance(input_data, str):
        internal_messages.append({"role": "user", "content": input_data})
    elif isinstance(input_data, list):
        for item in input_data:
            if isinstance(item, dict):
                role = item.get("role", "user")
                content = item.get("content", "")
                internal_messages.append({"role": role, "content": content})

    # instructions (optional system prompt)
    instructions = body.get("instructions", "")
    if instructions:
        internal_messages.insert(0, {"role": "system", "content": instructions})

    return {
        "messages": internal_messages,
        "model": model,
        "stream": stream,
        "tools": body.get("tools", []),
    }
