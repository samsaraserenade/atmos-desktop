"""Binance Spot balances, read with a read-only API key."""

from __future__ import annotations

import hashlib
import hmac
import time
from typing import Any
from urllib.parse import urlencode

from ..shared import STABLE_SYMBOLS, CollectorError, collected, holding, http

CONNECTOR = {
    "type": "binance",
    "name": "Binance Spot",
    "label": "Binance",
    "legacy_id": "binance-spot",
    "fields": [
        {"key": "api_key", "kind": "secret", "required": True, "prompt": "Binance read-only API key"},
        {"key": "api_secret", "kind": "secret", "required": True, "prompt": "Binance read-only API secret"},
    ],
    "dimensions": {"dapp": "Binance", "protocolType": "Exchange", "exchange": "Binance", "chain": "Exchange"},
}


def collect(config: dict[str, Any]) -> dict[str, Any]:
    key = str(config.get("api_key") or "")
    secret = str(config.get("api_secret") or "")
    if not key or not secret:
        raise CollectorError("credentials not configured")
    query = urlencode({"timestamp": int(time.time() * 1000), "recvWindow": 10000})
    signature = hmac.new(secret.encode(), query.encode(), hashlib.sha256).hexdigest()
    account = http.request(
        "https://api.binance.com/api/v3/account?" + query + "&signature=" + signature,
        headers={"X-MBX-APIKEY": key},
    )
    prices = http.request("https://api.binance.com/api/v3/ticker/price")
    price_map = {row["symbol"]: float(row["price"]) for row in prices if float(row.get("price") or 0) > 0}
    btc_usdt = price_map.get("BTCUSDT", 0)
    holdings = []
    for row in account.get("balances") or []:
        asset = str(row.get("asset") or "")
        quantity = float(row.get("free") or 0) + float(row.get("locked") or 0)
        if quantity <= 0:
            continue
        if asset in STABLE_SYMBOLS:
            price, kind = 1.0, "cash"
        elif price_map.get(asset + "USDT"):
            price, kind = price_map[asset + "USDT"], "invested"
        elif price_map.get(asset + "BTC") and btc_usdt:
            price, kind = price_map[asset + "BTC"] * btc_usdt, "invested"
        else:
            continue
        holdings.append(holding(asset, quantity, price, kind))
    return collected(holdings)
