"""Solana wallets: SOL and SPL tokens (priced through Jupiter, or a token's
Pump curve), staked JUP, and Jupiter Lock escrows."""

from __future__ import annotations

import time
from typing import Any
from urllib.parse import urlencode

from ..shared import DUST_USD, CollectorError, addresses, collected, holding, http, prices
from . import chain, jupiter, pump

CONNECTOR = {
    "type": "solana",
    "name": "Solana",
    "label": "Solana",
    "legacy_id": "solana-wallet",
    "fields": [
        {"key": "addresses", "kind": "addresses", "required": True, "prompt": "Solana addresses"},
        {"key": "jupiter_api_key", "kind": "secret",
         "prompt": "Jupiter API key (without one, only SOL and stablecoins are priced)"},
        {"key": "jupiter_locks", "kind": "addresses", "prompt": "Jupiter Lock escrow addresses"},
    ],
    "dimensions": {"dapp": "Wallet", "protocolType": "Wallet", "exchange": "Self-custody", "chain": "Solana"},
}

TOKEN_PROGRAMS = (jupiter.SPL_TOKEN_PROGRAM, jupiter.SPL_TOKEN_2022_PROGRAM)
STABLES = {
    "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v": "USDC",
    "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB": "USDT",
}

# Once a mint's ticker symbol has been resolved via Jupiter's token-search
# API, it's kept here for the life of the process. Without this, a single
# transient failure of that one search call (rate limit, timeout -- this
# collector talks to it every poll, for every held mint) made the
# affected token's holdings.append() use a mint-address-prefix string
# (see the mint[:6] fallback below) as its symbol for that one poll
# instead of its real ticker. Aggregating history by symbol (see
# src/totals.js and src/daily-attribution.js in the desktop plugin) then
# read that as the real token being fully withdrawn and a same-value
# phantom token being deposited, on a token that was actually untouched.
SYMBOL_CACHE: dict[str, str] = {}


def collect(config: dict[str, Any]) -> dict[str, Any]:
    watched = addresses(config)
    if not watched:
        raise CollectorError("addresses not configured")
    sol_price = prices.asset_price("SOL", "solana")
    holdings: list[dict[str, Any]] = []
    raw_tokens: dict[tuple[str, str], tuple[float, int]] = {}
    errors = 0
    try:
        locked_positions = jupiter.lock_positions(config)
    except CollectorError:
        locked_positions = []
        errors += 1
    for address in watched:
        try:
            balance = chain.rpc("getBalance", [address, {"commitment": "confirmed"}])
            sol_amount = float((balance or {}).get("value") or 0) / 1e9
            holdings.append(holding(
                "SOL", sol_amount, sol_price, meta={"walletAddress": address},
                holding_id=f"{address}:native:SOL",
            ))
            for program in TOKEN_PROGRAMS:
                try:
                    result = chain.rpc("getTokenAccountsByOwner", [
                        address, {"programId": program}, {"encoding": "jsonParsed", "commitment": "confirmed"},
                    ])
                    for account in (result or {}).get("value") or []:
                        info = (((account.get("account") or {}).get("data") or {}).get("parsed") or {}).get("info") or {}
                        token_amount = info.get("tokenAmount") or {}
                        amount = float(token_amount.get("uiAmount") or 0)
                        if amount > 0:
                            mint = str(info.get("mint") or "")
                            key = (address, mint)
                            previous = raw_tokens.get(key, (0.0, int(token_amount.get("decimals") or 0)))
                            raw_tokens[key] = (previous[0] + amount, int(token_amount.get("decimals") or 0))
                except (CollectorError, ValueError, TypeError):
                    errors += 1
        except (CollectorError, ValueError, TypeError):
            errors += 1

    # All watched wallets share one Jupiter price/metadata batch. Besides
    # avoiding duplicate lookups for a mint held in multiple wallets, this
    # keeps multi-wallet configurations below Jupiter's burst limit.
    mints = list({mint for _, mint in raw_tokens if mint} | {item["mint"] for item in locked_positions} | {jupiter.JUP_MINT})
    decimals_by_mint = {mint: decimals for (_, mint), (_, decimals) in raw_tokens.items() if mint}
    decimals_by_mint.update({item["mint"]: item["decimals"] for item in locked_positions})
    mint_prices: dict[str, float] = {}
    symbols: dict[str, str] = {}
    headers = {"x-api-key": str(config["jupiter_api_key"])} if config.get("jupiter_api_key") else {}
    for start in range(0, len(mints), 50):
        chunk = mints[start:start + 50]
        try:
            data = http.request("https://api.jup.ag/price/v3?" + urlencode({"ids": ",".join(chunk)}), headers=headers)
            for mint, item in data.items():
                token_price = float((item or {}).get("usdPrice") or 0)
                if token_price > 0:
                    mint_prices[mint] = token_price
        except (CollectorError, ValueError, TypeError):
            errors += 1
    unpriced_mints = [mint for mint in mints if mint not in mint_prices]
    if unpriced_mints:
        try:
            mint_prices.update(pump.curve_prices(unpriced_mints, decimals_by_mint, sol_price))
        except CollectorError:
            errors += 1
    for start in range(0, len(mint_prices), 50):
        chunk = list(mint_prices)[start:start + 50]
        try:
            metadata = http.request("https://api.jup.ag/tokens/v2/search?" + urlencode({"query": ",".join(chunk)}), headers=headers)
            for item in metadata if isinstance(metadata, list) else []:
                if item.get("id") and item.get("symbol"):
                    symbols[str(item["id"])] = str(item["symbol"])
                    SYMBOL_CACHE[str(item["id"])] = str(item["symbol"])
        except CollectorError:
            errors += 1
    for (address, mint), (amount, _) in raw_tokens.items():
        symbol = STABLES.get(mint, symbols.get(mint) or SYMBOL_CACHE.get(mint, mint[:6]))
        token_price = 1.0 if mint in STABLES else mint_prices.get(mint, 0)
        if amount * token_price >= DUST_USD:
            holdings.append(holding(
                symbol, amount, token_price, "cash" if symbol in {"USDC", "USDT"} else "invested",
                meta={"walletAddress": address}, holding_id=f"{address}:token:{mint}",
            ))

    for lock in locked_positions:
        mint = lock["mint"]
        symbol = STABLES.get(mint, symbols.get(mint) or SYMBOL_CACHE.get(mint, mint[:6]))
        token_price = 1.0 if mint in STABLES else mint_prices.get(mint, 0)
        if lock["quantity"] * token_price >= DUST_USD:
            holdings.append(holding(
                f"{symbol} (locked)", lock["quantity"], token_price,
                meta={
                    "dapp": "Jupiter Lock", "protocolType": "Vesting",
                    "walletAddress": lock["escrow"], "lockEscrow": lock["escrow"],
                    "cliffTime": lock["cliff_time"], "vestingEnd": lock["vesting_end"],
                },
                holding_id=f"jupiter-lock:{lock['escrow']}",
            ))

    for index, address in enumerate(watched):
        if index:
            time.sleep(jupiter.STAKE_REQUEST_SPACING_SECONDS)
        try:
            amount, stale = jupiter.staked_amount(address, config.get("jupiter_api_key"))
            jup_price = mint_prices.get(jupiter.JUP_MINT, 0)
            if amount * jup_price >= DUST_USD:
                holdings.append(holding(
                    "JUP (staked)", amount, jup_price,
                    meta={"walletAddress": address, "dapp": "Jupiter", "protocolType": "Staking"},
                    holding_id=f"{address}:stake:JUP",
                ))
            if stale:
                errors += 1
        except CollectorError:
            errors += 1
    return collected(holdings, errors)
