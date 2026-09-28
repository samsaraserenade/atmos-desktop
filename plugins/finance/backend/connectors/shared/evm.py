"""Helpers for EVM chains (BNB Chain, Arbitrum): ERC-20 balances over JSON-RPC."""

from __future__ import annotations

from typing import Any, Callable

from .http import CollectorError

Rpc = Callable[[str, list[Any]], Any]


def erc20_balance(rpc: Rpc, contract: str, address: str, decimals: int, chain: str) -> float:
    owner = address.lower().removeprefix("0x")
    if len(owner) != 40 or any(char not in "0123456789abcdef" for char in owner):
        raise CollectorError(f"{chain} address is invalid")
    data = "0x70a08231" + owner.rjust(64, "0")  # balanceOf(owner)
    raw = rpc("eth_call", [{"to": contract, "data": data}, "latest"])
    return int(raw or "0x0", 16) / (10 ** decimals)


def native_balance(rpc: Rpc, address: str) -> float:
    return int(rpc("eth_getBalance", [address, "latest"]) or "0x0", 16) / 1e18
