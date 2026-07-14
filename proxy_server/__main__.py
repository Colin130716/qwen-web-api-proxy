from __future__ import annotations

import argparse
import logging
import os
import secrets
from pathlib import Path

import uvicorn

from proxy_server.config import ProxyConfig
from proxy_server.server.api import create_app

logger = logging.getLogger(__name__)

KEY_FILE_ENV = "QWEN_PROXY_KEY_FILE"


def _resolve_key_file() -> str:
    """Return the key file path from env var or default (~/.qwen-proxy-key)."""
    return os.environ.get(KEY_FILE_ENV) or str(Path.home() / ".qwen-proxy-key")


def _load_key_from_file(key_file: str) -> str | None:
    """Read the API key from file if it exists and is non-empty."""
    try:
        key = Path(key_file).read_text().strip()
        if key:
            return key
    except (FileNotFoundError, PermissionError, OSError):
        pass
    return None


def _save_key_to_file(key: str, key_file: str) -> None:
    """Persist the API key to a file (0600 permissions)."""
    try:
        path = Path(key_file)
        path.write_text(key + "\n")
        path.chmod(0o600)
        logger.info("API key saved to %s", key_file)
    except (PermissionError, OSError) as e:
        logger.warning("Could not save API key to %s: %s", key_file, e)


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Qwen Web API Proxy - OpenAI-compatible API for Qwen web chat"
    )
    parser.add_argument(
        "--host",
        default=None,
        help="Bind host (default: 127.0.0.1)",
    )
    parser.add_argument(
        "--port",
        type=int,
        default=None,
        help="Bind port (default: 11434)",
    )
    parser.add_argument(
        "--api-key",
        default=None,
        help="API key for authentication. If not set, loads from key file or generates one.",
    )
    parser.add_argument(
        "--api-key-file",
        default=None,
        help=f"Path to API key file (default: ~/.qwen-proxy-key, overridable via {KEY_FILE_ENV})",
    )
    parser.add_argument(
        "--log-level",
        default="info",
        choices=["debug", "info", "warning", "error"],
        help="Logging level (default: info)",
    )
    parser.add_argument(
        "--reload",
        action="store_true",
        help="Enable auto-reload for development",
    )

    args = parser.parse_args()

    logging.basicConfig(
        level=getattr(logging, args.log_level.upper()),
        format="%(asctime)s  %(levelname)-8s %(name)s  %(message)s",
        datefmt="%H:%M:%S",
    )

    host = args.host or os.environ.get("QWEN_PROXY_HOST") or "127.0.0.1"
    port = args.port or int(os.environ.get("QWEN_PROXY_PORT", "11434"))
    key_file = args.api_key_file or _resolve_key_file()

    # api_key resolution: explicit > env var > key file > generate + persist
    api_key = args.api_key or os.environ.get("QWEN_PROXY_API_KEY")

    if not api_key:
        # Try loading from persistent key file
        api_key = _load_key_from_file(key_file)
        if api_key:
            logger.info("Loaded API key from %s", key_file)
        else:
            # Generate new key and persist it
            api_key = f"sk-{secrets.token_hex(24)}"
            logger.warning("No API key configured via --api-key or QWEN_PROXY_API_KEY env var.")
            logger.warning("Generated random key and saved to %s", key_file)
            _save_key_to_file(api_key, key_file)
    elif args.api_key:
        # Explicit CLI arg — persist for next time
        _save_key_to_file(api_key, key_file)

    config = ProxyConfig(host=host, port=port, api_key=api_key, api_key_file=key_file)

    logger.info("Starting Qwen Web API Proxy...")
    logger.info("  Host:      %s", config.host)
    logger.info("  Port:      %s", config.port)
    logger.info("  API Key:   %s...", config.api_key[:12] if len(config.api_key) > 12 else config.api_key)
    logger.info("  Key File:  %s", config.api_key_file)
    logger.info("  Endpoint:  http://%s:%d/v1", config.host, config.port)

    app = create_app(config)

    uvicorn.run(
        app,
        host=config.host,
        port=config.port,
        log_level=args.log_level,
        reload=args.reload,
    )


if __name__ == "__main__":
    main()
