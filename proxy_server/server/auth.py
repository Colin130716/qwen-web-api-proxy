import secrets

from fastapi import Request, HTTPException, status
from proxy_server.config import ProxyConfig


def verify_api_key(request: Request, config: ProxyConfig) -> None:
    """Checks the API key. Supports:

    - Authorization: Bearer <key>       (OpenAI / standard)
    - x-api-key: <key>                   (Anthropic-compatible)
    """
    token = _extract_token(request)
    if token is None:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Missing or invalid API key. Provide via Authorization: Bearer <key> or x-api-key header.",
            headers={"WWW-Authenticate": "Bearer"},
        )
    if not secrets.compare_digest(token, config.api_key):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid API Key",
            headers={"WWW-Authenticate": "Bearer"},
        )


def _extract_token(request: Request) -> str | None:
    """Try Authorization: Bearer first, then x-api-key."""
    auth = request.headers.get("Authorization", "")
    if auth.startswith("Bearer "):
        return auth[len("Bearer "):]

    x_key = request.headers.get("x-api-key")
    if x_key:
        return x_key

    return None
