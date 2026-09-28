"""Aptos wallets: APT, delegated (staked) APT, and fungible assets."""

from __future__ import annotations

from typing import Any

from ..shared import DUST_USD, STABLE_SYMBOLS, CollectorError, addresses, collected, holding, http, prices

CONNECTOR = {
    "type": "aptos",
    "name": "Aptos",
    "label": "Aptos",
    "legacy_id": "aptos-wallet",
    "fields": [
        {"key": "addresses", "kind": "addresses", "required": True, "prompt": "Aptos addresses"},
    ],
    "dimensions": {"dapp": "Wallet", "protocolType": "Wallet", "exchange": "Self-custody", "chain": "Aptos"},
}

GRAPH_QUERY = """query($addr:String!){
      current_fungible_asset_balances(where:{owner_address:{_eq:$addr},amount:{_gt:\"0\"}},limit:200){amount asset_type metadata{symbol decimals}}
      current_delegator_balances(where:{delegator_address:{_eq:$addr}},distinct_on:pool_address){pool_address}
    }"""


def _view(function: str, types: list[str], args: list[str]) -> Any:
    return http.post("https://fullnode.mainnet.aptoslabs.com/v1/view", {
        "function": function, "type_arguments": types, "arguments": args,
    })


def collect(config: dict[str, Any]) -> dict[str, Any]:
    watched = addresses(config)
    if not watched:
        raise CollectorError("addresses not configured")
    apt_price = prices.asset_price("APT", "aptos")
    quantities: dict[str, float] = {"APT": 0.0, "APT (staked)": 0.0}
    token_prices: dict[str, float] = {"APT": apt_price, "APT (staked)": apt_price}
    errors = 0
    for address in watched:
        try:
            native = _view("0x1::coin::balance", ["0x1::aptos_coin::AptosCoin"], [address])
            quantities["APT"] += int(native[0] if isinstance(native, list) else native) / 1e8
            graph = http.post("https://api.mainnet.aptoslabs.com/v1/graphql", {
                "query": GRAPH_QUERY, "variables": {"addr": address},
            })
            graph_data = graph.get("data") or {}
            for pool in {row.get("pool_address") for row in graph_data.get("current_delegator_balances") or []}:
                if not pool:
                    continue
                try:
                    stake = _view("0x1::delegation_pool::get_stake", [], [pool, address])
                    quantities["APT (staked)"] += sum(int(value or 0) for value in stake) / 1e8
                except (CollectorError, ValueError, TypeError):
                    errors += 1
            rows = graph_data.get("current_fungible_asset_balances") or []
            tokens: list[tuple[str, str, float]] = []
            for row in rows:
                metadata = row.get("metadata") or {}
                symbol = str(metadata.get("symbol") or "Token")
                if symbol.upper() == "APT":
                    continue
                amount = int(row.get("amount") or 0) / (10 ** int(metadata.get("decimals") or 0))
                tokens.append((str(row.get("asset_type") or ""), symbol, amount))
            price_map = prices.dex_prices([token[0] for token in tokens if token[0]])
            for asset_type, symbol, amount in tokens:
                token_price = 1.0 if symbol.upper() in STABLE_SYMBOLS else price_map.get(asset_type.lower(), (symbol, 0))[1]
                if amount * token_price >= DUST_USD:
                    quantities[symbol] = quantities.get(symbol, 0.0) + amount
                    token_prices[symbol] = token_price
        except (CollectorError, KeyError, ValueError, TypeError):
            errors += 1
    return collected([
        holding(symbol, quantity, token_prices.get(symbol, 0.0),
                "cash" if symbol.upper() in STABLE_SYMBOLS else "invested")
        for symbol, quantity in quantities.items()
    ], errors, watched)
