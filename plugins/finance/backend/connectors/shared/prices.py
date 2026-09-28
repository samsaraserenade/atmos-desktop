"""USD prices shared by connectors: Binance first, then CoinGecko, and
DexScreener for tokens neither lists."""

from __future__ import annotations

from typing import Any
from urllib.parse import urlencode

from . import http
from .http import CollectorError

STABLE_SYMBOLS = {"USDT", "USDC", "USDE", "DAI", "BUSD", "FDUSD", "TUSD", "USDP"}


def coingecko_price(coingecko_id: str) -> float:
    data = http.request("https://api.coingecko.com/api/v3/simple/price?" + urlencode({
        "ids": coingecko_id, "vs_currencies": "usd",
    }))
    price = float((data.get(coingecko_id) or {}).get("usd", 0))
    if price <= 0:
        raise CollectorError("asset price unavailable")
    return price


def coingecko_prices(coingecko_ids: list[str]) -> dict[str, float]:
    """Several CoinGecko ids in one request: id -> USD (0 when unpriced)."""
    data = http.request("https://api.coingecko.com/api/v3/simple/price?" + urlencode({
        "ids": ",".join(coingecko_ids), "vs_currencies": "usd",
    }))
    return {key: float((value or {}).get("usd") or 0) for key, value in data.items()}


def asset_price(binance_symbol: str, coingecko_id: str) -> float:
    try:
        data = http.request(f"https://api.binance.com/api/v3/ticker/price?symbol={binance_symbol}USDT")
        price = float(data.get("price", 0))
        if price > 0:
            return price
    except CollectorError:
        pass
    return coingecko_price(coingecko_id)


def dex_prices(addresses: list[str]) -> dict[str, tuple[str, float]]:
    """Token address (lower case) -> (symbol, USD), from each token's most liquid pair."""
    output: dict[str, tuple[str, float]] = {}
    for start in range(0, len(addresses), 30):
        chunk = addresses[start:start + 30]
        if not chunk:
            continue
        try:
            data = http.request("https://api.dexscreener.com/latest/dex/tokens/" + ",".join(chunk))
        except CollectorError:
            continue
        best: dict[str, dict[str, Any]] = {}
        for pair in data.get("pairs") or []:
            address = str((pair.get("baseToken") or {}).get("address", "")).lower()
            liquidity = float((pair.get("liquidity") or {}).get("usd") or 0)
            prior = float((best.get(address, {}).get("liquidity") or {}).get("usd") or 0)
            if address and liquidity > prior:
                best[address] = pair
        for address, pair in best.items():
            price = float(pair.get("priceUsd") or 0)
            if price > 0:
                output[address] = (str((pair.get("baseToken") or {}).get("symbol") or address[:8]), price)
    return output
