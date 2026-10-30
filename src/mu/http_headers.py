"""Identify Mu HTTP requests rather than using urllib's library user agent."""
from importlib.metadata import PackageNotFoundError, version

try:
    USER_AGENT = f"mu/{version('mu')}"
except PackageNotFoundError:
    USER_AGENT = "mu/dev"


def request_headers(headers: dict[str, str] | None = None) -> dict[str, str]:
    result = dict(headers or {})
    if not any(key.lower() == "user-agent" for key in result):
        result["User-Agent"] = USER_AGENT
    return result
