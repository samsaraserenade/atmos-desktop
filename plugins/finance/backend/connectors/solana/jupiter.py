"""Jupiter: governance-staked JUP, and Jupiter Lock escrows read from their
on-chain token vaults."""

from __future__ import annotations

import base64
import struct
import time
from typing import Any
from urllib.parse import quote

from ..shared import CollectorError, http
from . import chain

JUP_MINT = "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN"
STAKE_URL = "https://api.jup.ag/portfolio/v1/staked-jup/"
STAKE_CACHE_SECONDS = 5 * 60
STAKE_REQUEST_SPACING_SECONDS = 1.05
LOCK_PROGRAM = "LocpQgucEQHbqNABEYvBvwoxCPsSbG91A1QaQhQQqjn"
LOCK_DISCRIMINATOR = bytes((244, 119, 183, 4, 73, 116, 135, 195))
SPL_TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
SPL_TOKEN_2022_PROGRAM = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"
SPL_ASSOCIATED_TOKEN_PROGRAM = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL"
# address -> (fetched at, response)
STAKE_CACHE: dict[str, tuple[float, dict[str, Any]]] = {}


def staked_amount(address: str, api_key: Any = None) -> tuple[float, bool]:
    """Return total staked/unstaking JUP and whether stale cached data was used."""
    now = time.monotonic()
    cached = STAKE_CACHE.get(address)
    if cached and now - cached[0] < STAKE_CACHE_SECONDS:
        data = cached[1]
        stale = False
    else:
        headers = {"x-api-key": str(api_key)} if api_key else {}
        try:
            data = http.request(STAKE_URL + quote(address, safe=""), headers=headers)
            if not isinstance(data, dict):
                raise CollectorError("Jupiter staking response is invalid")
            STAKE_CACHE[address] = (now, data)
            stale = False
        except CollectorError:
            if not cached:
                raise
            data = cached[1]
            stale = True

    try:
        amount = float(data.get("stakedAmount") or 0)
        amount += sum(float(item.get("amount") or 0) for item in data.get("unstaking") or [])
    except (AttributeError, TypeError, ValueError):
        raise CollectorError("Jupiter staking response is invalid") from None
    return max(0.0, amount), stale


def lock_positions(config: dict[str, Any]) -> list[dict[str, Any]]:
    """Read configured Jupiter Lock escrows and their exact token vault balances."""
    raw_locks = config.get("jupiter_locks") or []
    if isinstance(raw_locks, str):
        raw_locks = [raw_locks]
    escrows = list(dict.fromkeys(str(value).strip() for value in raw_locks if str(value).strip()))[:20]
    if not escrows:
        return []
    if any(len(chain.base58_decode(escrow)) != 32 for escrow in escrows):
        raise CollectorError("invalid Jupiter Lock escrow address")

    response = chain.rpc("getMultipleAccounts", [
        escrows, {"encoding": "base64", "commitment": "confirmed"},
    ])
    accounts = (response or {}).get("value") or []
    decoded: list[dict[str, Any]] = []
    for index, escrow in enumerate(escrows):
        account = accounts[index] if index < len(accounts) else None
        try:
            if not account or account.get("owner") != LOCK_PROGRAM:
                raise CollectorError("Jupiter Lock escrow is unavailable")
            data = base64.b64decode((account.get("data") or [""])[0], validate=True)
            if len(data) != 296 or data[:8] != LOCK_DISCRIMINATOR:
                raise CollectorError("Jupiter Lock escrow data is invalid")
            token_program = SPL_TOKEN_2022_PROGRAM if data[139] == 1 else SPL_TOKEN_PROGRAM
            mint = chain.base58_encode(data[40:72])
            vault = chain.program_address([
                chain.base58_decode(escrow), chain.base58_decode(token_program), data[40:72],
            ], SPL_ASSOCIATED_TOKEN_PROGRAM)
            cliff_time, frequency, _, _, number_of_period = struct.unpack_from("<5Q", data, 144)
            decoded.append({
                "escrow": escrow, "mint": mint, "vault": vault,
                "token_program": token_program, "cliff_time": cliff_time,
                "vesting_end": cliff_time + frequency * number_of_period,
            })
        except (ValueError, TypeError, struct.error):
            raise CollectorError("Jupiter Lock escrow data is invalid") from None

    vaults = [item["vault"] for item in decoded]
    mints = [item["mint"] for item in decoded]
    vault_response = chain.rpc("getMultipleAccounts", [
        vaults, {"encoding": "base64", "commitment": "confirmed"},
    ])
    mint_response = chain.rpc("getMultipleAccounts", [
        mints, {"encoding": "base64", "commitment": "confirmed"},
    ])
    vault_accounts = (vault_response or {}).get("value") or []
    mint_accounts = (mint_response or {}).get("value") or []
    positions: list[dict[str, Any]] = []
    for index, item in enumerate(decoded):
        try:
            vault_account = vault_accounts[index] if index < len(vault_accounts) else None
            mint_account = mint_accounts[index] if index < len(mint_accounts) else None
            if not vault_account or not mint_account:
                raise CollectorError("Jupiter Lock token account is unavailable")
            vault_data = base64.b64decode((vault_account.get("data") or [""])[0], validate=True)
            mint_data = base64.b64decode((mint_account.get("data") or [""])[0], validate=True)
            if len(vault_data) < 72 or len(mint_data) < 45:
                raise CollectorError("Jupiter Lock token account is invalid")
            decimals = max(0, min(18, int(mint_data[44])))
            quantity = struct.unpack_from("<Q", vault_data, 64)[0] / (10 ** decimals)
            positions.append({**item, "quantity": quantity, "decimals": decimals})
        except (ValueError, TypeError, struct.error):
            raise CollectorError("Jupiter Lock token account is invalid") from None
    return positions
