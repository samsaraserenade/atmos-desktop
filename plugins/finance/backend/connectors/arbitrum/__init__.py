"""Arbitrum One wallets: native ETH and the main stablecoins, read directly over RPC."""

from __future__ import annotations

from typing import Any

from ..shared import CollectorError, addresses, collected, evm, holding, http, prices

CONNECTOR = {
    "type": "arbitrum",
    "name": "Arbitrum",
    "label": "Arbitrum",
    "legacy_id": "arbitrum-wallet",
    "fields": [
        {"key": "addresses", "kind": "addresses", "required": True, "prompt": "Arbitrum addresses"},
    ],
    "dimensions": {"dapp": "Wallet", "protocolType": "Wallet", "exchange": "Self-custody", "chain": "Arbitrum"},
}

RPC_ENDPOINTS = ("https://arb1.arbitrum.io/rpc", "https://arbitrum-one-rpc.publicnode.com")
TOKEN_CONTRACTS = {
    # Arbitrum One mainnet -- native USDC (Circle-issued) and the older
    # bridged USDC.e are two different contracts with the same peg; both
    # are summed into a single "USDC" holding below.
    "USDC": ("0xaf88d065e77c8cC2239327C5EDb3A432268e5831", 6),
    "USDC.e": ("0xFF970A61A04b1cA14834A43f5dE4533eBDDB5CC8", 6),
    "USDT": ("0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9", 6),
    "DAI": ("0xDA10009cBd5D07dd0CeCc66161FC93D7c9000da1", 18),
}


def _rpc(method: str, params: list[Any]) -> Any:
    return http.json_rpc(RPC_ENDPOINTS, method, params, "Arbitrum RPC unavailable")


def collect(config: dict[str, Any]) -> dict[str, Any]:
    watched = addresses(config)
    if not watched:
        raise CollectorError("addresses not configured")
    eth_price = prices.asset_price("ETH", "ethereum")
    holdings: list[dict[str, Any]] = []
    errors = 0
    for address in watched:
        try:
            holdings.append(holding(
                "ETH", evm.native_balance(_rpc, address), eth_price,
                meta={"walletAddress": address}, holding_id=f"{address}:native:ETH",
            ))
        except (CollectorError, ValueError, TypeError):
            errors += 1
        for symbol, (contract, decimals) in TOKEN_CONTRACTS.items():
            target = "USDC" if symbol == "USDC.e" else symbol
            try:
                holdings.append(holding(
                    target, evm.erc20_balance(_rpc, contract, address, decimals, "Arbitrum"),
                    1.0, "cash", meta={"walletAddress": address},
                    holding_id=f"{address}:token:{contract.lower()}",
                ))
            except (CollectorError, ValueError, TypeError):
                errors += 1
    return collected(holdings, errors, watched)
