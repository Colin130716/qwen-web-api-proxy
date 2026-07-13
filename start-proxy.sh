#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# Defaults
HOST="${QWEN_PROXY_HOST:-127.0.0.1}"
PORT="${QWEN_PROXY_PORT:-11434}"
LOG_LEVEL="${QWEN_LOG_LEVEL:-info}"

echo "Starting Qwen Web API Proxy..."
echo "  Host:     $HOST"
echo "  Port:     $PORT"
echo "  Log Level: $LOG_LEVEL"

# Assemble args
ARGS=(
  --host "$HOST"
  --port "$PORT"
  --log-level "$LOG_LEVEL"
)

# Only pass --api-key if explicitly set (avoids clobbering key file discovery)
if [ -n "${QWEN_PROXY_API_KEY:-}" ]; then
  ARGS+=(--api-key "$QWEN_PROXY_API_KEY")
fi

uv run python -m proxy_server "${ARGS[@]}" "$@"
