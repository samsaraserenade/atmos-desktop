"""Monero, from an amount entered by hand, priced through CoinGecko."""

from __future__ import annotations

from typing import Any

from ..shared import CollectorError, collected, holding, prices

CONNECTOR = {
    "type": "monero",
    "name": "Monero (manual amount)",
    "label": "Monero",
    "legacy_id": "monero-wallet",
    "fields": [
        {"key": "amount", "kind": "number", "required": True, "prompt": "Manual XMR amount"},
    ],
    "dimensions": {"dapp": "Wallet", "protocolType": "Wallet", "exchange": "Self-custody", "chain": "Monero"},
}


def collect(config: dict[str, Any]) -> dict[str, Any]:
    # Binance no longer supplies the live XMR market used by this collector.
    # Route Monero directly through CoinGecko instead of waiting for a failed
    # Binance request or accepting a stale exchange response.
    price = prices.coingecko_price("monero")
    try:
        total_xmr = max(0.0, float(config.get("amount") or 0))
    except (ValueError, TypeError):
        raise CollectorError("manual Monero amount is invalid") from None
    return collected([holding("XMR", total_xmr, price)])
