"""Injective wallets: INJ (liquid, staked, unbonding and rewards) and bank tokens."""

from __future__ import annotations

from typing import Any
from urllib.parse import quote

from ..shared import DUST_USD, STABLE_SYMBOLS, CollectorError, addresses, collected, holding, http, prices

CONNECTOR = {
    "type": "injective",
    "name": "Injective",
    "label": "Injective",
    "legacy_id": "inj-wallet",
    "fields": [
        {"key": "addresses", "kind": "addresses", "required": True, "prompt": "Injective addresses"},
    ],
    "dimensions": {"dapp": "Wallet", "protocolType": "Wallet", "exchange": "Self-custody", "chain": "Injective"},
}

API_BASES = ("https://lcd.injective.network", "https://injective-rest.publicnode.com")
TOKEN_LIST = "https://raw.githubusercontent.com/InjectiveLabs/injective-lists/master/json/tokens/mainnet.json"


def _get(path: str) -> Any:
    for base in API_BASES:
        try:
            return http.request(base + path)
        except CollectorError:
            pass
    raise CollectorError("Injective API unavailable")


def collect(config: dict[str, Any]) -> dict[str, Any]:
    watched = addresses(config)
    if not watched:
        raise CollectorError("addresses not configured")
    price = prices.asset_price("INJ", "injective-protocol")
    liquid_inj, staked_inj, errors = 0.0, 0.0, 0
    raw_tokens: list[tuple[str, int]] = []
    for address in watched:
        encoded = quote(address, safe="")
        try:
            balances = _get(f"/cosmos/bank/v1beta1/balances/{encoded}?pagination.limit=200")
            for coin in balances.get("balances") or []:
                if coin.get("denom") == "inj":
                    liquid_inj += int(coin.get("amount") or 0) / 1e18
                elif int(coin.get("amount") or 0) > 0:
                    raw_tokens.append((str(coin.get("denom") or ""), int(coin.get("amount") or 0)))
            stakes = _get(f"/cosmos/staking/v1beta1/delegations/{encoded}?pagination.limit=200")
            staked_inj += sum(int((row.get("balance") or {}).get("amount") or 0) / 1e18
                              for row in stakes.get("delegation_responses") or []
                              if (row.get("balance") or {}).get("denom") == "inj")
            try:
                unbonding = _get(f"/cosmos/staking/v1beta1/delegators/{encoded}/unbonding_delegations?pagination.limit=200")
                staked_inj += sum(int(entry.get("balance") or 0) / 1e18
                                  for row in unbonding.get("unbonding_responses") or []
                                  for entry in row.get("entries") or [])
            except CollectorError:
                errors += 1
            try:
                rewards = _get(f"/cosmos/distribution/v1beta1/delegators/{encoded}/rewards")
                staked_inj += sum(float(coin.get("amount") or 0) / 1e18
                                  for coin in rewards.get("total") or [] if coin.get("denom") == "inj")
            except CollectorError:
                errors += 1
        except (CollectorError, ValueError, TypeError):
            errors += 1

    quantities: dict[str, float] = {"INJ": liquid_inj, "INJ (staked)": staked_inj}
    token_prices: dict[str, float] = {"INJ": price, "INJ (staked)": price}
    if raw_tokens:
        try:
            token_list = http.request(TOKEN_LIST)
        except CollectorError:
            token_list = []
            errors += 1
        metadata = {str(item.get("denom")): item for item in token_list if isinstance(item, dict) and item.get("denom")}
        resolved = []
        for denom, raw_amount in raw_tokens:
            item = metadata.get(denom, {})
            symbol = str(item.get("symbol") or denom.split("/")[-1][:10]).upper()
            decimals = int(item.get("decimals") or (18 if denom.startswith(("inj", "peggy")) else 6))
            resolved.append({
                "denom": denom, "symbol": symbol, "amount": raw_amount / (10 ** decimals),
                "coingecko": item.get("coinGeckoId"), "address": item.get("address"),
            })
        cg_ids = sorted({item["coingecko"] for item in resolved if item["coingecko"] and item["symbol"] not in STABLE_SYMBOLS})
        cg_prices: dict[str, float] = {}
        if cg_ids:
            try:
                cg_prices = prices.coingecko_prices(cg_ids)
            except CollectorError:
                errors += 1
        dex = prices.dex_prices([str(item["address"]) for item in resolved if item["address"]])
        for item in resolved:
            if item["symbol"] in STABLE_SYMBOLS:
                token_price = 1.0
            elif item["coingecko"]:
                token_price = cg_prices.get(item["coingecko"], 0)
            else:
                token_price = dex.get(str(item["address"]).lower(), ("", 0))[1] if item["address"] else 0
            if item["amount"] * token_price >= DUST_USD:
                quantities[item["symbol"]] = quantities.get(item["symbol"], 0.0) + item["amount"]
                token_prices[item["symbol"]] = token_price
    return collected([
        holding(symbol, quantity, token_prices.get(symbol, 0.0),
                "cash" if symbol in STABLE_SYMBOLS else "invested")
        for symbol, quantity in quantities.items()
    ], errors, watched)
