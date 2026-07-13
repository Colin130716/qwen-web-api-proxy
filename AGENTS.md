# Qwen Web API Proxy

Browser extension + Python proxy that exposes chat.qwen.ai as an OpenAI `/v1/chat/completions` endpoint.

## Quick Start

```bash
# Proxy
./start-proxy.sh                       # default: 127.0.0.1:11434, random API key
QWEN_PROXY_API_KEY=sk-mykey ./start-proxy.sh  # or: --api-key sk-mykey

# Extension
cd browser-extension && npm run build   # IIFE content script + ES module (sw/popup)
```

## Architecture

```
Client (e.g. Cherry Studio)
  → HTTP POST /v1/chat/completions (Bearer auth)
    → proxy_server/ (FastAPI + uvicorn, single WS connection)
      → WebSocket execute message
        → browser-extension/src/content_script.ts (ISOLATED world)
          → Direct: fetch chat.qwen.ai/api/v2/chat/completions (primary)
          → Fallback: DOM automation + polling GET /api/v2/chats/<id>
```

**Two-Vite build** — both must run. `vite.content.config.ts` outputs IIFE (content script, no `import` allowed by MV3), `vite.main.config.ts` outputs ES modules (service worker + popup). Both write to `dist/`.

## Key Files

| File | Role |
|------|------|
| `proxy_server/server/ws_manager.py` | Singleton WS connection; `_reader_loop` runs **inline** in `connect()` — not a background task, must stay alive or ASGI scope drops |
| `proxy_server/server/api.py` | FastAPI routes; streaming (SSE) + non-streaming responses; WS auth via `api_key` query param |
| `proxy_server/server/openai_format.py` | OpenAI response shape — `reasoning_content`, `tool_calls`, `estimate_token_count` |
| `browser-extension/src/content_script.ts` | Session state (`currentChatId`), command routing (`/new`, `/change`, `/viewid`), system prompt caching for Cherry Studio split requests |
| `browser-extension/src/lib/qwen_api.ts` | Direct Qwen API client: `createQwenChat()`, `sendQwenMessage()`, `foldMessages()`, `parseQwenSSEDelta()` |
| `browser-extension/src/lib/tool_calling.ts` | Tool def injection → `<tool_call>` JSON blocks → parse/strip |
| `browser-extension/src/lib/ws_bridge.ts` | WsBridge class — WebSocket (reconnect, ping/15s, `reconfigure`) |
| `browser-extension/src/service_worker.ts` | Broadcasts `configUpdated` to tabs; key discovery; `executeDom` fallback into MAIN world |
| `browser-extension/src/page_script.js` | Fetch/XHR interceptor in MAIN world (SSE stream relay via `postMessage`) |

## Critical Conventions

- **WS reader loop is inline**: `ConnectionManager.connect()` awaits `_reader_loop()` directly. Do NOT wrap it in `asyncio.create_task()` — Starlette will close the ASGI scope and drop the connection.
- **Content script state**: `currentChatId`, `currentParentId`, `cachedSystemPrompt` are module-level variables. Lost on re-injection. State also lost when popup auto-syncs API key (triggers `configUpdated` → `bridge.reconfigure()` → disconnect/reconnect, which may re-inject).
- **Cherry Studio split requests**: System-only execute → cache prompt → inject into next user-message execute. `foldMessages()` prefixes `"System instructions:\n..."`.
- **Qwen SSE phases**: `thinking_summary` → reasoning text in `extra.summary_thought.content`; `answer` → content in `delta.content`.
- **No `role: "system"` to Qwen API**: Must fold system content into user message (`"System instructions:\n...\n\nUser: ..."`).
- **Tool calling**: Inject tool defs into system prompt; Qwen responds with `<tool_call>{...}</tool_call>` blocks; `<websearch>` tags also stripped.

## Commands

| Command | Build step | Output |
|---------|-----------|--------|
| `npm run build:content` | vite.content.config.ts | IIFE: `dist/src/content_script.js` |
| `npm run build:main` | vite.main.config.ts | ES modules: service worker + popup |
| `npm run build` | both | Both of the above |
| `uv run python -m proxy_server` | — | FastAPI on 127.0.0.1:11434 |

## Gotchas

- **No tests anywhere** in the repo — manual verification required.
- **API key auto-generation**: If no key provided, proxy logs a random `sk-{hex}` key. Extension popup auto-syncs from `/health` endpoint.
- **Vite copies icons**: `icon-48.png` and `icon-128.png` are copied from extension root to `dist/` by `viteStaticCopy` in `vite.content.config.ts`.
- **No `.gitignore`** — be careful not to commit `dist/`, `__pycache__`, `node_modules/`.
- **Only `ruff` configured** (no formatter, no type checker for Python; `tsconfig strict` for TypeScript).
- **`AbortController`** for request cancellation — new execute aborts the previous inflight request.
- **`/health` endpoint** returns `api_key` and `extension_connected` — used by popup for auto-sync and status display.
- **Python >=3.11 required** (from `pyproject.toml`).
