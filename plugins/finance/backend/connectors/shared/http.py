"""Network access for connectors: JSON over HTTPS, with sanitized errors.

Connectors call these through the module (`http.request(...)`), so a test
or a hosted runner can replace them in one place.
"""

from __future__ import annotations

import json
from typing import Any, Iterable
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

USER_AGENT = "AtmosPortfolioCollector/0.1"


class CollectorError(RuntimeError):
    """A deliberately sanitized provider failure (never carries a response body or secret)."""


def request(url: str, *, method: str = "GET", headers: dict[str, str] | None = None,
            body: Any = None, timeout: int = 20) -> Any:
    payload = None if body is None else json.dumps(body, separators=(",", ":")).encode()
    request_headers = {"Accept": "application/json", "User-Agent": USER_AGENT}
    if payload is not None:
        request_headers["Content-Type"] = "application/json"
    request_headers.update(headers or {})
    prepared = Request(url, data=payload, headers=request_headers, method=method)
    try:
        with urlopen(prepared, timeout=timeout) as response:
            raw = response.read(8 * 1024 * 1024)
        return json.loads(raw)
    except HTTPError as exc:
        raise CollectorError(f"provider returned HTTP {exc.code}") from None
    except (URLError, TimeoutError, OSError, json.JSONDecodeError):
        raise CollectorError("provider request failed") from None


def post(url: str, body: Any) -> Any:
    return request(url, method="POST", body=body)


def json_rpc(endpoints: Iterable[str], method: str, params: list[Any], unavailable: str) -> Any:
    """A JSON-RPC call, trying each endpoint in turn; `unavailable` is the error if none answers."""
    for endpoint in endpoints:
        try:
            data = post(endpoint, {"jsonrpc": "2.0", "method": method, "params": params, "id": 1})
            if not data.get("error"):
                return data.get("result")
        except CollectorError:
            pass
    raise CollectorError(unavailable)
