"""BNB Chain wallets: native BNB and Binance-Peg USDT, read directly over RPC."""

from __future__ import annotations

from typing import Any

from ..shared import CollectorError, addresses, collected, evm, holding, http, prices

CONNECTOR = {
    "type": "bsc",
    "name": "BNB Chain",
    "label": "BNB Chain",
    "legacy_id": "bsc-wallet",
    "fields": [
        {"key": "addresses", "kind": "addresses", "required": True, "prompt": "BSC addresses"},
    ],
    "dimensions": {"dapp": "Wallet", "protocolType": "Wallet", "exchange": "Self-custody", "chain": "BNB Chain"},
}

RPC_ENDPOINTS = ("https://bsc-dataseed.binance.org/", "https://bsc-rpc.publicnode.com")
USDT_CONTRACT = "0x55d398326f99059ff775485246999027b3197955"
USDT_DECIMALS = 18


def _rpc(method: str, params: list[Any]) -> Any:
    return http.json_rpc(RPC_ENDPOINTS, method, params, "BSC RPC unavailable")


def collect(config: dict[str, Any]) -> dict[str, Any]:
    watched = addresses(config)
    if not watched:
        raise CollectorError("addresses not configured")
    bnb_price = prices.asset_price("BNB", "binancecoin")
    holdings: list[dict[str, Any]] = []
    errors = 0
    for address in watched:
        try:
            holdings.append(holding(
                "BNB", evm.native_balance(_rpc, address), bnb_price,
                meta={"walletAddress": address}, holding_id=f"{address}:native:BNB",
            ))
        except (CollectorError, ValueError, TypeError):
            errors += 1
        try:
            holdings.append(holding(
                "USDT", evm.erc20_balance(_rpc, USDT_CONTRACT, address, USDT_DECIMALS, "BSC"), 1.0, "cash",
                meta={"walletAddress": address}, holding_id=f"{address}:token:{USDT_CONTRACT.lower()}",
            ))
        except (CollectorError, ValueError, TypeError):
            errors += 1
    return collected(holdings, errors, watched)
