# Qwen Web API Proxy

<p align="center">
  <img src="icon.png" alt="Qwen Web API Proxy" width="128" height="128">
</p>

<p align="center">
  <a href="README.md">中文</a> | <b>English</b>
</p>

<p align="center">
  Expose <a href="https://chat.qwen.ai">chat.qwen.ai</a> as OpenAI Chat Completions,
  Anthropic Messages, and OpenAI Responses API endpoints.
  <br>
  Works with Cherry Studio, OpenWebUI, Cursor, Claude clients, and any OpenAI SDK.
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="MIT License"></a>
</p>

## Features

- **Three API formats** — OpenAI Chat (`/v1/chat/completions`), Anthropic Messages (`/v1/messages`), OpenAI Responses (`/v1/responses`)
- **All Qwen models** — switch between Qwen3.7-Plus, Qwen3.7-Max, Qwen3-Coder, Qwen3-VL, and more via the `model` field
- **Vision / Multimodal** — send images via base64 data URIs; model auto-detects vision capability
- **Reasoning / Thinking** — Qwen's thinking phase exposed as `reasoning_content` (OpenAI) or `thinking` content blocks (Anthropic)
- **Streaming + Non-streaming** — SSE streaming with per-token reasoning and content deltas
- **Tool / Function Calling** — inject tool definitions, parse `<tool_call>` JSON responses
- **Multi-turn Conversations** — session-aware messaging with `/new`, `/change`, `/viewid`
- **Multi-extension support** — multiple browser tabs can share the proxy via ConnectionPool
- **Persistent API key** — auto-generated or custom key saved to `~/.qwen-proxy-key` (0600 permissions), survives restarts
- **Authentication** — supports both `Authorization: Bearer` and `x-api-key` headers

## How It Works

```
┌─────────────┐     POST /v1/chat/completions     ┌──────────────┐
│             │     POST /v1/messages              │              │
│   Client    │     POST /v1/responses             │    Proxy     │
│ (Cherry     │  ──────────────────────────────►   │  (FastAPI)   │
│  Studio,    │     Bearer <api-key>               │              │
│  Cursor,    │  ◄─── SSE stream / JSON ─────────  │              │
│  Claude     │                                    │              │
│  clients)   │                                    └──────┬───────┘
└─────────────┘                                           │ WebSocket
                                                          │ (?api_key=...)
                                                  ┌───────▼────────┐
                                                  │                 │
                                                  │   Browser       │
                                                  │   Extension     │
                                                  │  (MV3 / ISOLATED│
                                                  │   world)        │
                                                  │                 │
                                                  └───────┬─────────┘
                                                          │ fetch + cookies
                                                          │
                                                  ┌───────▼─────────┐
                                                  │                  │
                                                  │  chat.qwen.ai    │
                                                  │  /api/v2/chat/   │
                                                  │  completions     │
                                                  │                  │
                                                  └──────────────────┘
```

The proxy authenticates via API key and forwards requests to the browser extension over a single WebSocket connection. The extension (running on chat.qwen.ai) makes direct API calls with your browser's cookies — no credentials to manage.

**Two execution paths:**
1. **Direct API** (primary) — content script calls `chat.qwen.ai/api/v2/chat/completions` directly with `credentials: "include"`
2. **DOM automation** (fallback) — fills the chat input and presses Enter, then polls for the response via `GET /api/v2/chats/<id>`

## Prerequisites

- **Python ≥ 3.11** (required by the project)
- **uv** (Python package manager) — `pip install uv` or `curl -LsSf https://astral.sh/uv/install.sh | sh`
- **Node.js ≥ 18** (for building the extension)
- **Chrome / Edge** (for loading the unpacked extension)

## Quick Start

### 1. Start the Proxy Server

```bash
# Clone and enter the project
cd qwen-web-api-proxy

# Start the proxy (auto-generates a persistent API key)
./start-proxy.sh

# Or with a specific API key
QWEN_PROXY_API_KEY=sk-mysecret ./start-proxy.sh

# Custom host/port
QWEN_PROXY_HOST=0.0.0.0 QWEN_PROXY_PORT=8080 ./start-proxy.sh
```

On first run without an API key, the proxy generates a random key and saves it:

```
WARNING  No API key configured.
WARNING  Generated random key and saved to /home/user/.qwen-proxy-key
API Key:   sk-a1b2c3d4e5f6...
Key File:  /home/user/.qwen-proxy-key
```

The key persists across restarts. You can read it anytime: `cat ~/.qwen-proxy-key`

### 2. Build & Load the Extension

```bash
cd browser-extension
npm install
npm run build    # builds content script (IIFE) + service worker + popup (ES modules)
```

**In Chrome:**
1. Go to `chrome://extensions`
2. Enable **Developer mode** (top-right toggle)
3. Click **Load unpacked**
4. Select the `browser-extension/dist` directory

Open or refresh [chat.qwen.ai](https://chat.qwen.ai) in that browser.

### 3. Verify It Works

```bash
# Check proxy health
curl http://127.0.0.1:11434/health

# Expected response:
# {"status":"ok","extension_connected":true,"api_key":"sk-a1b2c3..."}
```

`extension_connected` should be `true` — this means the browser extension is connected via WebSocket.

## Usage

### List Available Models

```bash
curl http://127.0.0.1:11434/v1/models \
  -H "Authorization: Bearer sk-..."
```

Returns all 17 Qwen models plus backward-compatible aliases (`qwen-web`, `qwen-web-vision`), each with their capabilities (vision, thinking, search).

### API Endpoints

| Format | Endpoint | Auth |
|--------|----------|------|
| OpenAI Chat Completions | `POST /v1/chat/completions` | `Authorization: Bearer` |
| Anthropic Messages | `POST /v1/messages` | `Authorization: Bearer` or `x-api-key` |
| OpenAI Responses | `POST /v1/responses` | `Authorization: Bearer` |

### OpenAI Chat Completions

**Non-streaming:**

```bash
curl http://127.0.0.1:11434/v1/chat/completions \
  -H "Authorization: Bearer sk-..." \
  -H "Content-Type: application/json" \
  -d '{
    "model": "qwen3.7-plus",
    "messages": [
      {"role": "user", "content": "Hello! What is the capital of France?"}
    ]
  }'
```

**Streaming with thinking:**

```bash
curl -N http://127.0.0.1:11434/v1/chat/completions \
  -H "Authorization: Bearer sk-..." \
  -H "Content-Type: application/json" \
  -d '{
    "model": "qwen3.7-max",
    "stream": true,
    "messages": [
      {"role": "user", "content": "Explain quantum computing in 3 sentences."}
    ]
  }'
```

**Vision (multimodal):**

```bash
curl http://127.0.0.1:11434/v1/chat/completions \
  -H "Authorization: Bearer sk-..." \
  -H "Content-Type: application/json" \
  -d '{
    "model": "qwen3.7-plus",
    "messages": [
      {
        "role": "user",
        "content": [
          {"type": "text", "text": "What is in this image?"},
          {"type": "image_url", "image_url": {"url": "data:image/jpeg;base64,/9j/4AAQ..."}}
        ]
      }
    ]
  }'
```

**Tool / Function calling:**

```bash
curl http://127.0.0.1:11434/v1/chat/completions \
  -H "Authorization: Bearer sk-..." \
  -H "Content-Type: application/json" \
  -d '{
    "model": "qwen3.7-plus",
    "messages": [{"role": "user", "content": "What is the weather in Beijing?"}],
    "tools": [
      {
        "type": "function",
        "function": {
          "name": "get_weather",
          "description": "Get current weather for a city",
          "parameters": {
            "type": "object",
            "properties": {
              "location": {"type": "string"}
            },
            "required": ["location"]
          }
        }
      }
    ]
  }'
```

### Anthropic Messages

Compatible with Claude API clients (Cursor, Claude Desktop proxies, etc.).

```bash
curl http://127.0.0.1:11434/v1/messages \
  -H "x-api-key: sk-..." \
  -H "Content-Type: application/json" \
  -H "anthropic-version: 2023-06-01" \
  -d '{
    "model": "qwen3.7-max",
    "max_tokens": 4096,
    "stream": true,
    "system": "You are a helpful assistant.",
    "messages": [
      {"role": "user", "content": "Explain quantum computing."}
    ]
  }'
```

**With images (Anthropic format):**

```bash
curl http://127.0.0.1:11434/v1/messages \
  -H "x-api-key: sk-..." \
  -H "Content-Type: application/json" \
  -d '{
    "model": "qwen3.7-plus",
    "max_tokens": 4096,
    "messages": [{
      "role": "user",
      "content": [
        {"type": "text", "text": "What is this?"},
        {"type": "image", "source": {"type": "base64", "media_type": "image/jpeg", "data": "/9j/4AAQ..."}}
      ]
    }]
  }'
```

The streaming response uses Anthropic SSE events (`message_start`, `content_block_delta` with `thinking_delta`/`text_delta`, `message_stop`). Thinking content is delivered as `type: "thinking"` content blocks.

### OpenAI Responses

```bash
curl http://127.0.0.1:11434/v1/responses \
  -H "Authorization: Bearer sk-..." \
  -H "Content-Type: application/json" \
  -d '{
    "model": "qwen3.7-plus",
    "input": "Hello! What is the capital of France?",
    "instructions": "Be concise."
  }'
```

### Client Configuration

**Cherry Studio (OpenAI mode):**

| Setting | Value |
|---------|-------|
| API URL | `http://127.0.0.1:11434/v1` |
| API Key | From `~/.qwen-proxy-key` or proxy log |
| Model | Pick any model from `/v1/models` |

**Cherry Studio (Anthropic mode):**

| Setting | Value |
|---------|-------|
| API URL | `http://127.0.0.1:11434/v1` |
| API Key | From `~/.qwen-proxy-key` |
| Model | Pick any model from `/v1/models` |

**OpenAI Python SDK:**

```python
from openai import OpenAI

client = OpenAI(
    base_url="http://127.0.0.1:11434/v1",
    api_key="sk-a1b2c3d4e5f6...",
)

# List models
models = client.models.list()
for m in models:
    print(m.id)

# Chat completion
response = client.chat.completions.create(
    model="qwen3.7-max",
    messages=[{"role": "user", "content": "Hello!"}],
    stream=True,
)

for chunk in response:
    if chunk.choices[0].delta.reasoning_content:
        print(chunk.choices[0].delta.reasoning_content, end="", flush=True)
    if chunk.choices[0].delta.content:
        print(chunk.choices[0].delta.content, end="", flush=True)
```

**Anthropic Python SDK:**

```python
from anthropic import Anthropic

client = Anthropic(
    base_url="http://127.0.0.1:11434",
    api_key="sk-a1b2c3d4e5f6...",
)

message = client.messages.create(
    model="qwen3.7-plus",
    max_tokens=4096,
    system="You are a helpful assistant.",
    messages=[{"role": "user", "content": "Hello!"}],
    stream=True,
)

for event in message:
    if event.type == "content_block_delta":
        if event.delta.type == "text_delta":
            print(event.delta.text, end="", flush=True)
        elif event.delta.type == "thinking_delta":
            print(f"[thinking: {event.delta.text}]", end="", flush=True)
```

### API Key Management

The API key resolves with this priority:

1. `--api-key sk-xxx` CLI argument
2. `QWEN_PROXY_API_KEY=sk-xxx` environment variable
3. `~/.qwen-proxy-key` file (persisted from a previous run)
4. Auto-generated random key (saved to `~/.qwen-proxy-key` for future use)

```bash
# Use the saved key
cat ~/.qwen-proxy-key

# Set a custom key
echo -n "sk-my-custom-key" > ~/.qwen-proxy-key
chmod 600 ~/.qwen-proxy-key

# Or via env var (overrides file)
QWEN_PROXY_API_KEY=sk-mykey ./start-proxy.sh
```

## Session Commands

These commands can be sent as user messages to manage chat sessions:

| Command | Description |
|---------|-------------|
| `/help` | Show all available commands |
| `/deletechat <chat_id>` | Delete a chat session |
| `/new` | Create a new chat session |
| `/change <chat_id>` | Switch to an existing chat (from URL / URL path) |
| `/viewid` | Show the current chat session ID |
| `/viewchats` | List all chat sessions with IDs, titles and timestamps |
| `/enable-thinking` | Enable thinking mode (shows "思考" on the page) |
| `/disable-thinking` | Disable thinking mode (shows "快速" on the page) |
| `/enable-search` | Enable web search |
| `/disable-search` | Disable web search |
| `/genimage <prompt>` | Generate an image (uses t2i mode) |
| `/genppt <prompt>` | Generate a presentation (slides + PDF) |

## Configuration

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `QWEN_PROXY_HOST` | `127.0.0.1` | Proxy bind address |
| `QWEN_PROXY_PORT` | `11434` | Proxy bind port |
| `QWEN_PROXY_API_KEY` | auto-generated | API key for authentication |
| `QWEN_PROXY_KEY_FILE` | `~/.qwen-proxy-key` | Path to persisted API key file |
| `QWEN_LOG_LEVEL` | `info` | Log level (debug, info, warning, error) |

### CLI Arguments

```bash
uv run python -m proxy_server --help
```

```
--host HOST           Bind host (default: 127.0.0.1)
--port PORT           Bind port (default: 11434)
--api-key KEY         API key for authentication
--api-key-file PATH   Path to API key file (default: ~/.qwen-proxy-key)
--log-level LVL       Logging level (debug, info, warning, error)
--reload              Enable auto-reload for development
```

### Extension Options

Click the extension icon or right-click → **Options** to configure the proxy host, port, and API key in the popup. The API key is auto-synced from the proxy's `/health` endpoint every 3 seconds.

## Features in Detail

### Reasoning / Thinking Content

Qwen's thinking is exposed in all supported formats:

- **OpenAI Chat**: `choices[0].delta.reasoning_content` (streaming) or `choices[0].message.reasoning_content` (non-streaming)
- **Anthropic Messages**: `type: "thinking"` content block with `thinking_delta` streaming events
- **OpenAI Responses**: `output[].reasoning_content` field

No special configuration needed — it works out of the box.

### Vision / Multimodal Support

Models that support vision (indicated by `"capabilities": {"vision": true}` in `/v1/models`) accept images as base64 data URIs:

- **OpenAI format**: `content` array with `type: "image_url"` entries
- **Anthropic format**: `content` array with `type: "image"` + `source.type: "base64"` entries

The proxy validates that `image_url` must start with `data:image/` for security. If you use a model without vision capability with image inputs, the proxy logs a warning but proceeds.

### Dynamic Model Switching

All Qwen models available in your account can be used. Set the `model` field to any model ID from `/v1/models`:

| Model | Vision | Thinking | Search |
|-------|--------|----------|--------|
| `qwen3.7-plus` | ✅ | ✅ | ✅ |
| `qwen3.7-max` | ❌ | ✅ | ✅ |
| `qwen3-coder-plus` | ✅ | ✅ | ❌ |
| `qwen3-vl-plus` | ✅ | ✅ | ❌ |
| `qwen3.5-flash` | ✅ | ✅ | ✅ |
| `qwen3.5-omni-plus` | ✅ | ❌ | ✅ |
| `qwen-web` (alias) | → `qwen3.7-plus` | | |
| `qwen-web-vision` (alias) | → `qwen3.7-plus` | | |

### Tool / Function Calling

Send tool definitions in the standard format (same across OpenAI Chat and Anthropic Messages). The extension injects tool definitions into the system prompt and parses Qwen's `<tool_call>` JSON responses.

### Cherry Studio Compatibility

Cherry Studio sends system prompts and user messages as two separate HTTP requests. The extension caches the system prompt from the first request and automatically injects it into the second. Works in both OpenAI Chat and Anthropic Messages modes.

## Project Structure

```
├── proxy_server/              # Python FastAPI proxy
│   ├── __main__.py            # CLI entry point (key persistence, startup)
│   ├── config.py              # ProxyConfig dataclass
│   └── server/
│       ├── api.py             # FastAPI routes (chat completions, messages, responses, models, ws)
│       ├── auth.py            # Bearer + x-api-key authentication
│       ├── openai_format.py   # OpenAI response formatting, model catalog, message validation
│       ├── response_formats.py # Anthropic Messages + OpenAI Responses formatters & parsers
│       └── ws_manager.py      # WebSocket connection manager, ConnectionPool
├── browser-extension/         # Chrome MV3 extension
│   ├── manifest.json
│   ├── src/
│   │   ├── content_script.ts  # Main logic: commands, Qwen API calls, WS bridge
│   │   ├── service_worker.ts  # Background: key discovery, page script injection
│   │   ├── page_script.js     # MAIN world: fetch/XHR SSE interception
│   │   ├── popup/             # Configuration popup UI
│   │   └── lib/
│   │       ├── qwen_api.ts    # Direct Qwen API client (vision, files support)
│   │       ├── tool_calling.ts # Tool def injection & response parsing
│   │       ├── ws_bridge.ts   # WebSocket client (reconnect, ping, reconfigure)
│   │       └── types.ts       # Shared types (ExecuteMessage, ChatContext, etc.)
│   ├── vite.content.config.ts # Vite config: content script (IIFE)
│   └── vite.main.config.ts   # Vite config: service worker + popup (ES)
├── start-proxy.sh             # Convenience start script
├── icon.png                   # Application icon (406x406)
└── pyproject.toml             # Python project config (ruff, deps)
```

## Development

```bash
# Python proxy (auto-reload enabled)
uv run python -m proxy_server --reload

# Build extension after changes
cd browser-extension && npm run build

# After rebuilding the extension, reload it at chrome://extensions
```

## Limitations

- Requires an open browser tab on chat.qwen.ai (the extension runs there)
- Token counting is estimated (~4 chars per token), not from Qwen
- The DOM automation fallback is fragile and only used when the direct API fails
- Anthropic tool_use blocks in incoming messages are stripped (Qwen handles tools differently)
- Some Omni models (`qwen3.5-omni-plus`, `qwen3-omni-flash-2025-12-01`) may not be available to all accounts

## Known Issues

1. **Cherry Studio search conflict**: Cherry Studio's built-in search must be disabled when using this proxy, otherwise responses may break.
2. **Messages not visible on the page**: Messages sent via the API won't appear on the chat.qwen.ai page immediately. You need to refresh the page after receiving the response to see the conversation history. **Important: only refresh after the client has received the response**, otherwise the request will fail.

## License

[MIT](LICENSE) © qwen-web-api-proxy

---

<p align="center">
  <a href="README.md">阅读本文的中文版本</a>
</p>
