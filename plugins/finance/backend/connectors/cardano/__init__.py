"""Cardano wallets (payment or stake addresses), through Koios."""

from __future__ import annotations

from typing import Any

from ..shared import CollectorError, addresses, collected, holding, http, prices

CONNECTOR = {
    "type": "cardano",
    "name": "Cardano",
    "label": "Cardano",
    "legacy_id": "cardano-wallet",
    "fields": [
        {"key": "addresses", "kind": "addresses", "required": True, "prompt": "Cardano addresses"},
    ],
    "dimensions": {"dapp": "Wallet", "protocolType": "Wallet", "exchange": "Self-custody", "chain": "Cardano"},
}


def collect(config: dict[str, Any]) -> dict[str, Any]:
    watched = addresses(config)
    if not watched:
        raise CollectorError("addresses not configured")
    price = prices.asset_price("ADA", "cardano")
    holdings, errors = [], 0
    for address in watched:
        try:
            stake = address.startswith(("stake1", "stake_test1"))
            endpoint = "/account_info" if stake else "/address_info"
            key = "_stake_addresses" if stake else "_addresses"
            data = http.post("https://api.koios.rest/api/v1" + endpoint, {key: [address]})
            if not data:
                raise CollectorError("address not found")
            row = data[0]
            lovelace = int(row.get("total_balance") or row.get("balance") or 0)
            if stake:
                lovelace += int(row.get("rewards_available") or row.get("unclaimed_rewards") or 0)
            holdings.append(holding(
                "ADA" if not stake else "ADA (staked)", lovelace / 1e6, price,
                meta={
                    "walletAddress": address,
                    **({"dapp": "Cardano Staking", "protocolType": "Staking"} if stake else {}),
                },
                holding_id=f"{address}:{'stake' if stake else 'native'}:ADA",
            ))
        except (CollectorError, ValueError, TypeError):
            errors += 1
    return collected(holdings, errors, watched)
