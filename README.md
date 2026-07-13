# Qwen Web API Proxy

<p align="center">
  <img src="icon.png" alt="Qwen Web API Proxy" width="128" height="128">
</p>

<p align="center">
  <b>中文</b> | <a href="README-EN.md">English</a>
</p>

<p align="center">
  将 <a href="https://chat.qwen.ai">chat.qwen.ai</a> 暴露为 OpenAI Chat Completions、
  Anthropic Messages 和 OpenAI Responses API 端点。
  <br>
  兼容 Cherry Studio、OpenWebUI、Cursor、Claude 客户端及任意 OpenAI SDK。
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="MIT License"></a>
</p>

---

<p align="center">
  <a href="#功能特性">功能特性</a> •
  <a href="#原理">原理</a> •
  <a href="#快速开始">快速开始</a> •
  <a href="#使用指南">使用指南</a> •
  <a href="#配置">配置</a> •
  <a href="#功能详解">功能详解</a>
</p>

---

## 功能特性

- **三种 API 格式** — OpenAI Chat (`/v1/chat/completions`)、Anthropic Messages (`/v1/messages`)、OpenAI Responses (`/v1/responses`)
- **所有 Qwen 模型** — 通过 `model` 字段自由切换 Qwen3.7-Plus、Qwen3.7-Max、Qwen3-Coder、Qwen3-VL 等模型
- **视觉 / 多模态** — 通过 base64 data URI 发送图片，自动检测模型视觉能力
- **推理 / 思考** — Qwen 的思考阶段暴露为 `reasoning_content`（OpenAI）或 `thinking` 内容块（Anthropic）
- **流式 + 非流式** — SSE 流式输出，支持逐 token 的推理和内容增量
- **工具调用 / Function Calling** — 注入工具定义，解析 `<tool_call>` JSON 响应
- **多轮对话** — 通过 `/new`、`/change`、`/viewid` 管理会话
- **多插件支持** — ConnectionPool 支持多个浏览器标签页共用代理
- **持久化 API Key** — 自动生成或自定义 key 保存到 `~/.qwen-proxy-key`（权限 0600），重启后不丢失
- **认证** — 同时支持 `Authorization: Bearer` 和 `x-api-key` 请求头

## 原理

```
┌─────────────┐     POST /v1/chat/completions     ┌──────────────┐
│             │     POST /v1/messages              │              │
│   客户端    │     POST /v1/responses             │   代理服务   │
│ (Cherry     │  ──────────────────────────────►   │  (FastAPI)   │
│  Studio、   │     Bearer <api-key>               │              │
│  Cursor、   │  ◄─── SSE 流 / JSON ────────────  │              │
│  Claude 等) │                                    │              │
└─────────────┘                                    └──────┬───────┘
                                                           │ WebSocket
                                                           │ (?api_key=...)
                                                   ┌───────▼────────┐
                                                   │                 │
                                                   │   浏览器插件    │
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

代理服务通过 API Key 认证，将请求通过 WebSocket 转发给浏览器插件。插件运行在 chat.qwen.ai 页面中，使用浏览器 Cookie 直接调用 Qwen API——无需额外管理凭证。

**两种执行路径：**
1. **直接 API**（主要）— content script 直接请求 `chat.qwen.ai/api/v2/chat/completions`，携带 `credentials: "include"`
2. **DOM 自动化**（兜底）— 填入聊天输入框并回车，然后轮询 `GET /api/v2/chats/<id>` 获取响应

## 环境要求

- **Python ≥ 3.11**
- **uv**（Python 包管理器）— `pip install uv` 或 `curl -LsSf https://astral.sh/uv/install.sh | sh`
- **Node.js ≥ 18**（用于构建插件）
- **Chrome / Edge**（用于加载解压后的插件）

## 快速开始

### 1. 启动代理服务

```bash
# 克隆并进入项目
cd qwen-web-api-proxy

# 启动代理（自动生成持久化 API Key）
./start-proxy.sh

# 或指定自定义 API Key
QWEN_PROXY_API_KEY=sk-mysecret ./start-proxy.sh

# 自定义主机/端口
QWEN_PROXY_HOST=0.0.0.0 QWEN_PROXY_PORT=8080 ./start-proxy.sh
```

首次启动未配置 API Key 时，代理会自动生成并保存到文件：

```
WARNING  No API key configured.
WARNING  Generated random key and saved to /home/user/.qwen-proxy-key
API Key:   sk-a1b2c3d4e5f6...
Key File:  /home/user/.qwen-proxy-key
```

Key 会持久化保存，重启后自动加载。随时查看：`cat ~/.qwen-proxy-key`

### 2. 构建并加载插件

```bash
cd browser-extension
npm install
npm run build    # 构建 content script (IIFE) + service worker + popup (ES modules)
```

**在 Chrome 中：**
1. 打开 `chrome://extensions`
2. 开启右上角 **开发者模式**
3. 点击 **加载已解压的扩展程序**
4. 选择 `browser-extension/dist` 目录

在浏览器中打开或刷新 [chat.qwen.ai](https://chat.qwen.ai)。

### 3. 验证是否正常工作

```bash
# 检查代理健康状态
curl http://127.0.0.1:11434/health

# 预期响应：
# {"status":"ok","extension_connected":true,"api_key":"sk-a1b2c3..."}
```

`extension_connected` 应为 `true`——表示浏览器插件已通过 WebSocket 连接到代理。

## 使用指南

### 查看可用模型

```bash
curl http://127.0.0.1:11434/v1/models \
  -H "Authorization: Bearer sk-..."
```

返回全部 17 个 Qwen 模型及向后兼容的别名（`qwen-web`、`qwen-web-vision`），每个模型携带其能力标记（视觉、思考、搜索）。

### API 端点一览

| 格式 | 端点 | 认证方式 |
|------|------|----------|
| OpenAI Chat | `POST /v1/chat/completions` | `Authorization: Bearer` |
| Anthropic Messages | `POST /v1/messages` | `Authorization: Bearer` 或 `x-api-key` |
| OpenAI Responses | `POST /v1/responses` | `Authorization: Bearer` |

### OpenAI Chat Completions

**非流式请求：**

```bash
curl http://127.0.0.1:11434/v1/chat/completions \
  -H "Authorization: Bearer sk-..." \
  -H "Content-Type: application/json" \
  -d '{
    "model": "qwen3.7-plus",
    "messages": [
      {"role": "user", "content": "你好！法国的首都是什么？"}
    ]
  }'
```

**流式请求（含思考过程）：**

```bash
curl -N http://127.0.0.1:11434/v1/chat/completions \
  -H "Authorization: Bearer sk-..." \
  -H "Content-Type: application/json" \
  -d '{
    "model": "qwen3.7-max",
    "stream": true,
    "messages": [
      {"role": "user", "content": "用三句话解释量子计算。"}
    ]
  }'
```

**图片识别：**

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
          {"type": "text", "text": "这张图里是什么？"},
          {"type": "image_url", "image_url": {"url": "data:image/jpeg;base64,/9j/4AAQ..."}}
        ]
      }
    ]
  }'
```

**工具调用 / Function Calling：**

```bash
curl http://127.0.0.1:11434/v1/chat/completions \
  -H "Authorization: Bearer sk-..." \
  -H "Content-Type: application/json" \
  -d '{
    "model": "qwen3.7-plus",
    "messages": [{"role": "user", "content": "北京天气怎么样？"}],
    "tools": [
      {
        "type": "function",
        "function": {
          "name": "get_weather",
          "description": "获取某个城市的当前天气",
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

兼容 Claude API 客户端（Cursor、Claude Desktop 代理等）。

```bash
curl http://127.0.0.1:11434/v1/messages \
  -H "x-api-key: sk-..." \
  -H "Content-Type: application/json" \
  -H "anthropic-version: 2023-06-01" \
  -d '{
    "model": "qwen3.7-max",
    "max_tokens": 4096,
    "stream": true,
    "system": "你是一个乐于助人的助手。",
    "messages": [
      {"role": "user", "content": "解释量子计算。"}
    ]
  }'
```

**带图片的 Anthropic 格式：**

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
        {"type": "text", "text": "这是什么？"},
        {"type": "image", "source": {"type": "base64", "media_type": "image/jpeg", "data": "/9j/4AAQ..."}}
      ]
    }]
  }'
```

流式响应使用 Anthropic SSE 事件（`message_start`、`content_block_delta` with `thinking_delta`/`text_delta`、`message_stop`）。思考内容通过 `type: "thinking"` 内容块传递。

### OpenAI Responses

```bash
curl http://127.0.0.1:11434/v1/responses \
  -H "Authorization: Bearer sk-..." \
  -H "Content-Type: application/json" \
  -d '{
    "model": "qwen3.7-plus",
    "input": "你好！法国的首都是什么？",
    "instructions": "回答要简洁。"
  }'
```

### 客户端配置

**Cherry Studio（OpenAI 模式）：**

| 设置 | 值 |
|------|-----|
| API 地址 | `http://127.0.0.1:11434/v1` |
| API Key | 从 `~/.qwen-proxy-key` 或代理日志获取 |
| 模型 | 从 `/v1/models` 任选 |

**Cherry Studio（Anthropic 模式）：**

| 设置 | 值 |
|------|-----|
| API 地址 | `http://127.0.0.1:11434/v1` |
| API Key | 从 `~/.qwen-proxy-key` 获取 |
| 模型 | 从 `/v1/models` 任选 |

**OpenAI Python SDK：**

```python
from openai import OpenAI

client = OpenAI(
    base_url="http://127.0.0.1:11434/v1",
    api_key="sk-a1b2c3d4e5f6...",
)

# 查看模型列表
models = client.models.list()
for m in models:
    print(m.id)

# 聊天补全
response = client.chat.completions.create(
    model="qwen3.7-max",
    messages=[{"role": "user", "content": "你好！"}],
    stream=True,
)

for chunk in response:
    if chunk.choices[0].delta.reasoning_content:
        print(chunk.choices[0].delta.reasoning_content, end="", flush=True)
    if chunk.choices[0].delta.content:
        print(chunk.choices[0].delta.content, end="", flush=True)
```

**Anthropic Python SDK：**

```python
from anthropic import Anthropic

client = Anthropic(
    base_url="http://127.0.0.1:11434",
    api_key="sk-a1b2c3d4e5f6...",
)

message = client.messages.create(
    model="qwen3.7-plus",
    max_tokens=4096,
    system="你是一个乐于助人的助手。",
    messages=[{"role": "user", "content": "你好！"}],
    stream=True,
)

for event in message:
    if event.type == "content_block_delta":
        if event.delta.type == "text_delta":
            print(event.delta.text, end="", flush=True)
        elif event.delta.type == "thinking_delta":
            print(f"[思考: {event.delta.text}]", end="", flush=True)
```

### API Key 管理

API Key 按以下优先级解析：

1. `--api-key sk-xxx` 命令行参数
2. `QWEN_PROXY_API_KEY=sk-xxx` 环境变量
3. `~/.qwen-proxy-key` 文件（上次运行持久化的 key）
4. 自动生成随机 key（保存到 `~/.qwen-proxy-key` 供后续使用）

```bash
# 查看已保存的 key
cat ~/.qwen-proxy-key

# 设置自定义 key
echo -n "sk-my-custom-key" > ~/.qwen-proxy-key
chmod 600 ~/.qwen-proxy-key

# 或通过环境变量（优先级高于文件）
QWEN_PROXY_API_KEY=sk-mykey ./start-proxy.sh
```

## 会话命令

以下命令通过用户消息发送，用于管理聊天会话：

| 命令 | 说明 |
|------|------|
| `/help` | 显示所有可用命令 |
| `/deletechat <chat_id>` | 删除指定聊天会话 |
| `/new` | 创建新的聊天会话 |
| `/change <chat_id>` | 切换到指定会话（从 URL / URL 路径） |
| `/viewid` | 显示当前会话 ID |
| `/viewchats` | 列出所有会话 ID、标题和时间 |
| `/enable-thinking` | 开启思考模式（网页显示"思考"） |
| `/disable-thinking` | 关闭思考模式（网页显示"快速"） |
| `/enable-search` | 开启联网搜索 |
| `/disable-search` | 关闭联网搜索 |
| `/genimage <prompt>` | 生成图片（使用 t2i 模式） |
| `/genppt <prompt>` | 生成 PPT（幻灯片 + PDF） |

## 配置

### 环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `QWEN_PROXY_HOST` | `127.0.0.1` | 代理绑定地址 |
| `QWEN_PROXY_PORT` | `11434` | 代理绑定端口 |
| `QWEN_PROXY_API_KEY` | 自动生成 | API 认证密钥 |
| `QWEN_PROXY_KEY_FILE` | `~/.qwen-proxy-key` | API Key 持久化文件路径 |
| `QWEN_LOG_LEVEL` | `info` | 日志级别 (debug, info, warning, error) |

### 命令行参数

```bash
uv run python -m proxy_server --help
```

```
--host HOST           绑定地址（默认: 127.0.0.1）
--port PORT           绑定端口（默认: 11434）
--api-key KEY         API 认证密钥
--api-key-file PATH   API Key 持久化文件路径（默认: ~/.qwen-proxy-key）
--log-level LVL       日志级别（debug, info, warning, error）
--reload              启用开发模式热重载
```

### 插件选项

点击扩展图标或右键 → **选项** 可在弹窗中配置代理主机、端口和 API Key。API Key 会每 3 秒通过代理的 `/health` 端点自动同步。

## 功能详解

### 推理 / 思考内容

Qwen 的思考过程在所有支持的格式中均可获取：

- **OpenAI Chat**：流式 `choices[0].delta.reasoning_content`，非流式 `choices[0].message.reasoning_content`
- **Anthropic Messages**：`type: "thinking"` 内容块，流式输出 `thinking_delta` 事件
- **OpenAI Responses**：`output[].reasoning_content` 字段

无需额外配置，开箱即用。

### 视觉 / 多模态支持

支持视觉的模型（`/v1/models` 中 `"capabilities": {"vision": true}`）可接收 base64 data URI 格式的图片：

- **OpenAI 格式**：`content` 数组中的 `type: "image_url"` 条目
- **Anthropic 格式**：`content` 数组中的 `type: "image"` + `source.type: "base64"` 条目

代理会验证 `image_url` 必须以 `data:image/` 开头（安全性要求）。如果使用不支持视觉的模型发送图片，代理会打印警告日志但仍会继续执行。

### 动态模型切换

账户中可用的所有 Qwen 模型均可使用。将 `model` 字段设置为 `/v1/models` 中的任意模型 ID：

| 模型 | 视觉 | 思考 | 搜索 |
|------|------|------|------|
| `qwen3.7-plus` | ✅ | ✅ | ✅ |
| `qwen3.7-max` | ❌ | ✅ | ✅ |
| `qwen3-coder-plus` | ✅ | ✅ | ❌ |
| `qwen3-vl-plus` | ✅ | ✅ | ❌ |
| `qwen3.5-flash` | ✅ | ✅ | ✅ |
| `qwen3.5-omni-plus` | ✅ | ❌ | ✅ |
| `qwen-web`（别名） | → `qwen3.7-plus` | | |
| `qwen-web-vision`（别名） | → `qwen3.7-plus` | | |

### 工具调用 / Function Calling

按照标准格式发送工具定义（OpenAI Chat 和 Anthropic Messages 均支持）。插件会将工具定义注入到系统提示词中，并解析 Qwen 返回的 `<tool_call>` JSON 响应。

### Cherry Studio 兼容性

Cherry Studio 会将系统提示词和用户消息分两次 HTTP 请求发送。插件会缓存第一次请求中的系统提示词，并自动注入到第二次请求的用户消息中。在 OpenAI Chat 和 Anthropic Messages 模式下均可正常工作。

## 项目结构

```
├── proxy_server/              # Python FastAPI 代理
│   ├── __main__.py            # CLI 入口（Key 持久化、启动配置）
│   ├── config.py              # ProxyConfig 数据类
│   └── server/
│       ├── api.py             # FastAPI 路由（chat completions, messages, responses, models, ws）
│       ├── auth.py            # Bearer + x-api-key 认证
│       ├── openai_format.py   # OpenAI 响应格式化、模型目录、消息验证
│       ├── response_formats.py # Anthropic Messages + OpenAI Responses 格式化器与解析器
│       └── ws_manager.py      # WebSocket 连接管理器、ConnectionPool
├── browser-extension/         # Chrome MV3 扩展
│   ├── manifest.json
│   ├── src/
│   │   ├── content_script.ts  # 主逻辑：命令处理、Qwen API 调用、WS 桥接
│   │   ├── service_worker.ts  # 后台：Key 发现、page script 注入
│   │   ├── page_script.js     # MAIN world：fetch/XHR SSE 拦截
│   │   ├── popup/             # 配置弹窗 UI
│   │   └── lib/
│   │       ├── qwen_api.ts    # 直接 Qwen API 客户端（支持视觉、文件）
│   │       ├── tool_calling.ts # 工具定义注入与响应解析
│   │       ├── ws_bridge.ts   # WebSocket 客户端（重连、心跳、重配置）
│   │       └── types.ts       # 共享类型定义
│   ├── vite.content.config.ts # Vite 配置：content script（IIFE）
│   └── vite.main.config.ts   # Vite 配置：service worker + popup（ES）
├── start-proxy.sh             # 便捷启动脚本
├── icon.png                   # 应用图标（406x406）
└── pyproject.toml             # Python 项目配置（ruff、依赖）
```

## 开发

```bash
# Python 代理（启用热重载）
uv run python -m proxy_server --reload

# 修改插件后重新构建
cd browser-extension && npm run build

# 重新构建后，在 chrome://extensions 中刷新插件
```

## 已知限制

- 需要在浏览器中保持 chat.qwen.ai 标签页打开（插件运行在该页面上）
- Token 计数为估算值（约 4 字符/token），非 Qwen 实际计数
- DOM 自动化兜底方案较为脆弱，仅在直接 API 调用失败时使用
- 传入的 Anthropic 消息中的 tool_use 块会被丢弃（Qwen 使用不同的工具调用机制）
- 部分 Omni 模型（`qwen3.5-omni-plus`、`qwen3-omni-flash-2025-12-01`）可能对部分账户不可用

## 已知问题

1. **Cherry Studio 搜索冲突**：使用 Cherry Studio 时需要关闭 Cherry Studio 自带的搜索功能，否则会导致回复出问题。
2. **消息不在网页显示**：通过 API 发送消息后，网页上不会立即显示该消息及回复。需要在客户端收到回复后刷新 chat.qwen.ai 页面才能看到聊天记录。**注意：一定要在收到消息后刷新**，否则请求会失败。

## 许可证

[MIT](LICENSE) © qwen-web-api-proxy

---

<p align="center">
  <a href="README-EN.md">Read this document in English</a>
</p>
