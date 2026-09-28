"""Solana RPC and the address maths the Solana connector needs (base58 and
program-derived addresses), without a crypto dependency."""

from __future__ import annotations

import hashlib
from typing import Any

from ..shared import CollectorError, http

RPC_ENDPOINTS = ("https://api.mainnet.solana.com", "https://api.mainnet-beta.solana.com")

_BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"
_BASE58_INDEX = {character: index for index, character in enumerate(_BASE58_ALPHABET)}
_ED25519_P = 2 ** 255 - 19
_ED25519_D = (-121665 * pow(121666, _ED25519_P - 2, _ED25519_P)) % _ED25519_P
_ED25519_I = pow(2, (_ED25519_P - 1) // 4, _ED25519_P)


def rpc(method: str, params: list[Any]) -> Any:
    return http.json_rpc(RPC_ENDPOINTS, method, params, "Solana RPC unavailable")


def base58_decode(value: str) -> bytes:
    number = 0
    try:
        for character in value:
            number = number * 58 + _BASE58_INDEX[character]
    except KeyError:
        raise CollectorError("invalid Solana address") from None
    raw = number.to_bytes((number.bit_length() + 7) // 8, "big") if number else b""
    return b"\0" * (len(value) - len(value.lstrip("1"))) + raw


def base58_encode(value: bytes) -> str:
    number = int.from_bytes(value, "big")
    encoded = ""
    while number:
        number, remainder = divmod(number, 58)
        encoded = _BASE58_ALPHABET[remainder] + encoded
    return "1" * (len(value) - len(value.lstrip(b"\0"))) + (encoded or "")


def _ed25519_is_on_curve(compressed: bytes) -> bool:
    """Match Solana's PDA check without adding a crypto dependency."""
    if len(compressed) != 32:
        return False
    sign = compressed[31] >> 7
    y = int.from_bytes(compressed, "little") & ((1 << 255) - 1)
    if y >= _ED25519_P:
        return False
    y_squared = y * y % _ED25519_P
    numerator = (y_squared - 1) % _ED25519_P
    denominator = (_ED25519_D * y_squared + 1) % _ED25519_P
    x_squared = numerator * pow(denominator, _ED25519_P - 2, _ED25519_P) % _ED25519_P
    x = pow(x_squared, (_ED25519_P + 3) // 8, _ED25519_P)
    if (x * x - x_squared) % _ED25519_P:
        x = x * _ED25519_I % _ED25519_P
    if (x * x - x_squared) % _ED25519_P:
        return False
    return not (x == 0 and sign)


def program_address(seeds: list[bytes], program: str) -> str:
    program_bytes = base58_decode(program)
    if len(program_bytes) != 32 or any(len(seed) > 32 for seed in seeds):
        raise CollectorError("invalid Solana program address")
    for bump in range(255, -1, -1):
        candidate = hashlib.sha256(
            b"".join([*seeds, bytes((bump,)), program_bytes, b"ProgramDerivedAddress"])
        ).digest()
        if not _ed25519_is_on_curve(candidate):
            return base58_encode(candidate)
    raise CollectorError("Solana program address unavailable")
