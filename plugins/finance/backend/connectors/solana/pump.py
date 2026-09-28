"""Prices for Pump tokens no price service lists yet, from their on-chain
bonding curves."""

from __future__ import annotations

import base64
import struct
import time

from . import chain

PROGRAM = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P"
BONDING_CURVE_DISCRIMINATOR = bytes((23, 183, 248, 55, 96, 216, 172, 96))
CACHE_SECONDS = 30
# mint -> (checked at, decimals, USD per token; 0 when it has no curve price)
PRICE_CACHE: dict[str, tuple[float, int, float]] = {}

# Quote assets a Pump curve can be paired with, besides native SOL (an
# all-zero quote_mint): mint -> (decimals, fixed USD price). USDC-paired
# coins launched in May 2026 (pump-public-docs, "USDC paired coins").
STABLE_QUOTES = {
    "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v": (6, 1.0),  # USDC
    "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB": (6, 1.0),  # USDT
}


def curve_price(data: bytes, decimals: int, sol_price: float) -> float:
    """Return USD per whole token for an incomplete Pump curve (SOL-, USDC- or USDT-paired)."""
    if len(data) < 49 or data[:8] != BONDING_CURVE_DISCRIMINATOR:
        return 0.0
    virtual_tokens, virtual_quote, _, _, _ = struct.unpack_from("<QQQQQ", data, 8)
    complete = bool(data[48])
    if complete or virtual_tokens <= 0 or virtual_quote <= 0:
        return 0.0
    # quote_mint was appended after creator + two flags. Missing means a
    # legacy SOL pair; an all-zero pubkey is also Pump's native-SOL marker.
    quote_mint = data[83:115] if len(data) >= 115 else b"\0" * 32
    if any(quote_mint):
        quote = STABLE_QUOTES.get(chain.base58_encode(quote_mint))
        if not quote:
            return 0.0
        quote_decimals, quote_usd = quote
    else:
        quote_decimals, quote_usd = 9, sol_price
    token_units = virtual_tokens / (10 ** max(0, min(18, int(decimals))))
    quote_units = virtual_quote / (10 ** quote_decimals)
    return quote_units / token_units * quote_usd if token_units > 0 else 0.0


def curve_prices(mints: list[str], decimals: dict[str, int], sol_price: float) -> dict[str, float]:
    """Batch-price unlisted Pump tokens from their on-chain curve accounts."""
    now = time.monotonic()
    result: dict[str, float] = {}
    missing: list[str] = []
    for mint in dict.fromkeys(mints):
        cached = PRICE_CACHE.get(mint)
        mint_decimals = int(decimals.get(mint, 0))
        if cached and cached[1] == mint_decimals and now - cached[0] < CACHE_SECONDS:
            if cached[2] > 0:
                result[mint] = cached[2]
        else:
            missing.append(mint)

    for start in range(0, len(missing), 100):
        chunk = missing[start:start + 100]
        addresses = [
            chain.program_address([b"bonding-curve", chain.base58_decode(mint)], PROGRAM)
            for mint in chunk
        ]
        response = chain.rpc("getMultipleAccounts", [
            addresses, {"encoding": "base64", "commitment": "confirmed"},
        ])
        accounts = (response or {}).get("value") or []
        for index, mint in enumerate(chunk):
            account = accounts[index] if index < len(accounts) else None
            price = 0.0
            try:
                if account and account.get("owner") == PROGRAM:
                    encoded = (account.get("data") or [""])[0]
                    price = curve_price(
                        base64.b64decode(encoded, validate=True), decimals.get(mint, 0), sol_price,
                    )
            except (ValueError, TypeError, struct.error):
                price = 0.0
            PRICE_CACHE[mint] = (now, int(decimals.get(mint, 0)), price)
            if price > 0:
                result[mint] = price
    return result
