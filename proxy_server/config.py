import dataclasses
import os
import secrets
from dataclasses import dataclass
from pathlib import Path


def _default_key_file() -> str:
    return str(Path.home() / ".qwen-proxy-key")


@dataclass
class ProxyConfig:
    host: str = "127.0.0.1"
    port: int = 11434
    api_key: str = dataclasses.field(default_factory=lambda: f"sk-{secrets.token_hex(24)}")
    api_key_file: str = dataclasses.field(default_factory=_default_key_file)
