#!/usr/bin/env python3
"""Read-only finance collectors for the Atmos portfolio backend.

Only the Python standard library is used. Secrets are loaded from a protected
JSON file and are never included in logs, exceptions, database rows, or API
responses.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import struct
import sys
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.parse import quote, urlencode
from urllib.request import Request, urlopen

import server


DEFAULT_CONFIG = "/etc/atmos-portfolio-sources.json"
DEFAULT_POLL_SECONDS = 60
USER_AGENT = "AtmosPortfolioCollector/0.1"
DUST_USD = 0.01
STABLE_SYMBOLS = {"USDT", "USDC", "USDE", "DAI", "BUSD", "FDUSD", "TUSD", "USDP"}
BSC_USDT_CONTRACT = "0x55d398326f99059ff775485246999027b3197955"
BSC_USDT_DECIMALS = 18


class CollectorError(RuntimeError):
    """A deliberately sanitized provider failure."""


def _request(url: str, *, method: str = "GET", headers: dict[str, str] | None = None,
             body: Any = None, timeout: int = 20) -> Any:
    payload = None if body is None else json.dumps(body, separators=(",", ":")).encode()
    request_headers = {"Accept": "application/json", "User-Agent": USER_AGENT}
    if payload is not None:
        request_headers["Content-Type"] = "application/json"
    request_headers.update(headers or {})
    request = Request(url, data=payload, headers=request_headers, method=method)
    try:
        with urlopen(request, timeout=timeout) as response:
            raw = response.read(8 * 1024 * 1024)
        return json.loads(raw)
    except HTTPError as exc:
        raise CollectorError(f"provider returned HTTP {exc.code}") from None
    except (URLError, TimeoutError, OSError, json.JSONDecodeError):
        raise CollectorError("provider request failed") from None


def _post(url: str, body: Any) -> Any:
    return _request(url, method="POST", body=body)


def _addresses(config: dict[str, Any]) -> list[str]:
    result: list[str] = []
    raw = config.get("addresses") or []
    if isinstance(raw, str):
        raw = [raw]
    for item in raw:
        value = item if isinstance(item, str) else item.get("address", item.get("addr", ""))
        value = str(value).strip()
        if value and value not in result:
            result.append(value)
    return result


def _holding(symbol: str, quantity: float, price: float, kind: str = "invested",
             meta: dict[str, Any] | None = None, holding_id: str | None = None) -> dict[str, Any]:
    """A single position. Quantity and price are kept separately (rather than
    only their product) so a later balance change can be attributed to a
    price move versus an actual change in units held, with no manual entry
    required. `meta` is an opaque bag of extra, source-specific numbers
    (funding rate, leverage, ...) that server.py stores but never interprets
    -- see its _clean_holding_meta() for the size/shape limits it enforces."""
    quantity = max(0.0, float(quantity))
    price = max(0.0, float(price))
    return {"id": (holding_id or f"{symbol}:{kind}")[:160], "symbol": symbol[:32], "quantity": quantity, "price": price,
            "value": quantity * price, "kind": kind, "meta": meta}


SOURCE_DIMENSIONS = {
    "binance-spot": {"dapp": "Binance", "protocolType": "Exchange", "exchange": "Binance", "chain": "Exchange"},
    "cardano-wallet": {"dapp": "Wallet", "protocolType": "Wallet", "exchange": "Self-custody", "chain": "Cardano"},
    "bsc-wallet": {"dapp": "Wallet", "protocolType": "Wallet", "exchange": "Self-custody", "chain": "BNB Chain"},
    "arbitrum-wallet": {"dapp": "Wallet", "protocolType": "Wallet", "exchange": "Self-custody", "chain": "Arbitrum"},
    "aptos-wallet": {"dapp": "Wallet", "protocolType": "Wallet", "exchange": "Self-custody", "chain": "Aptos"},
    "inj-wallet": {"dapp": "Wallet", "protocolType": "Wallet", "exchange": "Self-custody", "chain": "Injective"},
    "monero-wallet": {"dapp": "Wallet", "protocolType": "Wallet", "exchange": "Self-custody", "chain": "Monero"},
    "solana-wallet": {"dapp": "Wallet", "protocolType": "Wallet", "exchange": "Self-custody", "chain": "Solana"},
    "hyperliquid-wallet": {"dapp": "Hyperliquid", "protocolType": "Perpetuals", "exchange": "Hyperliquid", "chain": "Hyperliquid L1"},
}


def _source(source_id: str, label: str, holdings: list[dict[str, Any]], errors: int = 0,
            wallet_addresses: list[str] | None = None) -> dict[str, Any]:
    # A cross-margin perp can remain open after its position-local
    # marginUsed + unrealizedPnl falls to zero. Its loss is covered by the
    # account's shared collateral, so a zero equity value does not mean the
    # position is closed. Keep those rows for the Futures UI; ordinary
    # zero-value holdings are still dust and remain omitted.
    holdings = [
        item for item in holdings
        if item["value"] > 0 or (
            (item.get("meta") or {}).get("instrument") == "perp"
            and item.get("quantity", 0) > 0
        )
    ]
    defaults = SOURCE_DIMENSIONS.get(source_id, {})
    for holding in holdings:
        meta = {**defaults, **(holding.get("meta") or {})}
        if not meta.get("walletAddress") and wallet_addresses:
            meta["walletAddress"] = wallet_addresses[0] if len(wallet_addresses) == 1 else "Multiple wallets"
        if meta.get("account") == "earn":
            meta["protocolType"] = "Lending"
        elif source_id == "hyperliquid-wallet" and meta.get("instrument") not in ("perp", "perp-cash"):
            meta["protocolType"] = "Exchange"
        elif "staked" in str(holding.get("symbol") or "").lower():
            meta["protocolType"] = "Staking"
            if meta.get("dapp") == "Wallet":
                meta["dapp"] = f"{meta.get('chain', 'Native')} Staking"
        elif meta.get("instrument") in ("perp", "perp-cash"):
            meta["protocolType"] = meta.get("protocolType") or "Perpetuals"
        holding["meta"] = meta or None
    return {
        "id": source_id,
        "label": label,
        "value": sum(item["value"] for item in holdings),
        "error_count": max(0, errors),
        "holdings": holdings,
    }


def _coingecko_price(coingecko_id: str) -> float:
    data = _request("https://api.coingecko.com/api/v3/simple/price?" + urlencode({
        "ids": coingecko_id, "vs_currencies": "usd",
    }))
    price = float((data.get(coingecko_id) or {}).get("usd", 0))
    if price <= 0:
        raise CollectorError("asset price unavailable")
    return price


def _asset_price(binance_symbol: str, coingecko_id: str) -> float:
    try:
        data = _request(f"https://api.binance.com/api/v3/ticker/price?symbol={binance_symbol}USDT")
        price = float(data.get("price", 0))
        if price > 0:
            return price
    except CollectorError:
        pass
    return _coingecko_price(coingecko_id)


def _dex_prices(addresses: list[str]) -> dict[str, tuple[str, float]]:
    output: dict[str, tuple[str, float]] = {}
    for start in range(0, len(addresses), 30):
        chunk = addresses[start:start + 30]
        if not chunk:
            continue
        try:
            data = _request("https://api.dexscreener.com/latest/dex/tokens/" + ",".join(chunk))
        except CollectorError:
            continue
        best: dict[str, dict[str, Any]] = {}
        for pair in data.get("pairs") or []:
            address = str((pair.get("baseToken") or {}).get("address", "")).lower()
            liquidity = float((pair.get("liquidity") or {}).get("usd") or 0)
            prior = float((best.get(address, {}).get("liquidity") or {}).get("usd") or 0)
            if address and liquidity > prior:
                best[address] = pair
        for address, pair in best.items():
            price = float(pair.get("priceUsd") or 0)
            if price > 0:
                output[address] = (str((pair.get("baseToken") or {}).get("symbol") or address[:8]), price)
    return output


def collect_binance(config: dict[str, Any]) -> dict[str, Any]:
    key = str(config.get("api_key") or "")
    secret = str(config.get("api_secret") or "")
    if not key or not secret:
        raise CollectorError("credentials not configured")
    query = urlencode({"timestamp": int(time.time() * 1000), "recvWindow": 10000})
    signature = hmac.new(secret.encode(), query.encode(), hashlib.sha256).hexdigest()
    account = _request(
        "https://api.binance.com/api/v3/account?" + query + "&signature=" + signature,
        headers={"X-MBX-APIKEY": key},
    )
    prices = _request("https://api.binance.com/api/v3/ticker/price")
    price_map = {row["symbol"]: float(row["price"]) for row in prices if float(row.get("price") or 0) > 0}
    btc_usdt = price_map.get("BTCUSDT", 0)
    holdings = []
    for row in account.get("balances") or []:
        asset = str(row.get("asset") or "")
        quantity = float(row.get("free") or 0) + float(row.get("locked") or 0)
        if quantity <= 0:
            continue
        if asset in STABLE_SYMBOLS:
            price, kind = 1.0, "cash"
        elif price_map.get(asset + "USDT"):
            price, kind = price_map[asset + "USDT"], "invested"
        elif price_map.get(asset + "BTC") and btc_usdt:
            price, kind = price_map[asset + "BTC"] * btc_usdt, "invested"
        else:
            continue
        holdings.append(_holding(asset, quantity, price, kind))
    return _source("binance-spot", "BNB", holdings)


def collect_cardano(config: dict[str, Any]) -> dict[str, Any]:
    addresses = _addresses(config)
    if not addresses:
        raise CollectorError("addresses not configured")
    price = _asset_price("ADA", "cardano")
    holdings, errors = [], 0
    for address in addresses:
        try:
            stake = address.startswith(("stake1", "stake_test1"))
            endpoint = "/account_info" if stake else "/address_info"
            key = "_stake_addresses" if stake else "_addresses"
            data = _post("https://api.koios.rest/api/v1" + endpoint, {key: [address]})
            if not data:
                raise CollectorError("address not found")
            row = data[0]
            lovelace = int(row.get("total_balance") or row.get("balance") or 0)
            if stake:
                lovelace += int(row.get("rewards_available") or row.get("unclaimed_rewards") or 0)
            holdings.append(_holding(
                "ADA" if not stake else "ADA (staked)", lovelace / 1e6, price,
                meta={
                    "walletAddress": address,
                    **({"dapp": "Cardano Staking", "protocolType": "Staking"} if stake else {}),
                },
                holding_id=f"{address}:{'stake' if stake else 'native'}:ADA",
            ))
        except (CollectorError, ValueError, TypeError):
            errors += 1
    return _source("cardano-wallet", "ADA", holdings, errors, addresses)


def _bsc_rpc(method: str, params: list[Any]) -> Any:
    for base in ("https://bsc-dataseed.binance.org/", "https://bsc-rpc.publicnode.com"):
        try:
            data = _post(base, {"jsonrpc": "2.0", "method": method, "params": params, "id": 1})
            if not data.get("error"):
                return data.get("result")
        except CollectorError:
            pass
    raise CollectorError("BSC RPC unavailable")


def _bsc_erc20_balance(contract: str, address: str, decimals: int) -> float:
    owner = address.lower().removeprefix("0x")
    if len(owner) != 40 or any(char not in "0123456789abcdef" for char in owner):
        raise CollectorError("BSC address is invalid")
    data = "0x70a08231" + owner.rjust(64, "0")
    raw = _bsc_rpc("eth_call", [{"to": contract, "data": data}, "latest"])
    return int(raw or "0x0", 16) / (10 ** decimals)


def collect_bsc(config: dict[str, Any]) -> dict[str, Any]:
    addresses = _addresses(config)
    if not addresses:
        raise CollectorError("addresses not configured")
    bnb_price = _asset_price("BNB", "binancecoin")
    holdings: list[dict[str, Any]] = []
    errors = 0
    for address in addresses:
        try:
            raw = _bsc_rpc("eth_getBalance", [address, "latest"])
            holdings.append(_holding(
                "BNB", int(raw or "0x0", 16) / 1e18, bnb_price,
                meta={"walletAddress": address}, holding_id=f"{address}:native:BNB",
            ))
        except (CollectorError, ValueError, TypeError):
            errors += 1
        try:
            holdings.append(_holding(
                "USDT", _bsc_erc20_balance(BSC_USDT_CONTRACT, address, BSC_USDT_DECIMALS), 1.0, "cash",
                meta={"walletAddress": address}, holding_id=f"{address}:token:{BSC_USDT_CONTRACT.lower()}",
            ))
        except (CollectorError, ValueError, TypeError):
            errors += 1
    return _source("bsc-wallet", "BNB", holdings, errors, addresses)


ARBITRUM_TOKEN_CONTRACTS = {
    # Arbitrum One mainnet -- native USDC (Circle-issued) and the older
    # bridged USDC.e are two different contracts with the same peg; both
    # are summed into a single "USDC" holding below.
    "USDC": ("0xaf88d065e77c8cC2239327C5EDb3A432268e5831", 6),
    "USDC.e": ("0xFF970A61A04b1cA14834A43f5dE4533eBDDB5CC8", 6),
    "USDT": ("0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9", 6),
    "DAI": ("0xDA10009cBd5D07dd0CeCc66161FC93D7c9000da1", 18),
}


def _arbitrum_rpc(method: str, params: list[Any]) -> Any:
    for base in ("https://arb1.arbitrum.io/rpc", "https://arbitrum-one-rpc.publicnode.com"):
        try:
            data = _post(base, {"jsonrpc": "2.0", "method": method, "params": params, "id": 1})
            if not data.get("error"):
                return data.get("result")
        except CollectorError:
            pass
    raise CollectorError("Arbitrum RPC unavailable")


def _arbitrum_erc20_balance(contract: str, address: str, decimals: int) -> float:
    owner = address.lower().removeprefix("0x")
    if len(owner) != 40 or any(char not in "0123456789abcdef" for char in owner):
        raise CollectorError("Arbitrum address is invalid")
    data = "0x70a08231" + owner.rjust(64, "0")
    raw = _arbitrum_rpc("eth_call", [{"to": contract, "data": data}, "latest"])
    return int(raw or "0x0", 16) / (10 ** decimals)


def collect_arbitrum(config: dict[str, Any]) -> dict[str, Any]:
    addresses = _addresses(config)
    if not addresses:
        raise CollectorError("addresses not configured")
    eth_price = _asset_price("ETH", "ethereum")
    holdings: list[dict[str, Any]] = []
    errors = 0
    for address in addresses:
        try:
            raw = _arbitrum_rpc("eth_getBalance", [address, "latest"])
            holdings.append(_holding(
                "ETH", int(raw or "0x0", 16) / 1e18, eth_price,
                meta={"walletAddress": address}, holding_id=f"{address}:native:ETH",
            ))
        except (CollectorError, ValueError, TypeError):
            errors += 1
        for symbol, (contract, decimals) in ARBITRUM_TOKEN_CONTRACTS.items():
            target = "USDC" if symbol == "USDC.e" else symbol
            try:
                holdings.append(_holding(
                    target, _arbitrum_erc20_balance(contract, address, decimals),
                    1.0, "cash", meta={"walletAddress": address},
                    holding_id=f"{address}:token:{contract.lower()}",
                ))
            except (CollectorError, ValueError, TypeError):
                errors += 1
    return _source("arbitrum-wallet", "ETH", holdings, errors, addresses)


def _aptos_view(function: str, types: list[str], args: list[str]) -> Any:
    return _post("https://fullnode.mainnet.aptoslabs.com/v1/view", {
        "function": function, "type_arguments": types, "arguments": args,
    })


def collect_aptos(config: dict[str, Any]) -> dict[str, Any]:
    addresses = _addresses(config)
    if not addresses:
        raise CollectorError("addresses not configured")
    apt_price = _asset_price("APT", "aptos")
    quantities: dict[str, float] = {"APT": 0.0, "APT (staked)": 0.0}
    prices: dict[str, float] = {"APT": apt_price, "APT (staked)": apt_price}
    errors = 0
    query = """query($addr:String!){
      current_fungible_asset_balances(where:{owner_address:{_eq:$addr},amount:{_gt:\"0\"}},limit:200){amount asset_type metadata{symbol decimals}}
      current_delegator_balances(where:{delegator_address:{_eq:$addr}},distinct_on:pool_address){pool_address}
    }"""
    for address in addresses:
        try:
            native = _aptos_view("0x1::coin::balance", ["0x1::aptos_coin::AptosCoin"], [address])
            quantities["APT"] += int(native[0] if isinstance(native, list) else native) / 1e8
            graph = _post("https://api.mainnet.aptoslabs.com/v1/graphql", {
                "query": query, "variables": {"addr": address},
            })
            graph_data = graph.get("data") or {}
            for pool in {row.get("pool_address") for row in graph_data.get("current_delegator_balances") or []}:
                if not pool:
                    continue
                try:
                    stake = _aptos_view("0x1::delegation_pool::get_stake", [], [pool, address])
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
            price_map = _dex_prices([token[0] for token in tokens if token[0]])
            for asset_type, symbol, amount in tokens:
                token_price = 1.0 if symbol.upper() in STABLE_SYMBOLS else price_map.get(asset_type.lower(), (symbol, 0))[1]
                value = amount * token_price
                if value >= DUST_USD:
                    quantities[symbol] = quantities.get(symbol, 0.0) + amount
                    prices[symbol] = token_price
        except (CollectorError, KeyError, ValueError, TypeError):
            errors += 1
    return _source("aptos-wallet", "APT", [
        _holding(symbol, quantity, prices.get(symbol, 0.0),
                 "cash" if symbol.upper() in STABLE_SYMBOLS else "invested")
        for symbol, quantity in quantities.items()
    ], errors, addresses)


def _inj_get(path: str) -> Any:
    for base in ("https://lcd.injective.network", "https://injective-rest.publicnode.com"):
        try:
            return _request(base + path)
        except CollectorError:
            pass
    raise CollectorError("Injective API unavailable")


def collect_injective(config: dict[str, Any]) -> dict[str, Any]:
    addresses = _addresses(config)
    if not addresses:
        raise CollectorError("addresses not configured")
    price = _asset_price("INJ", "injective-protocol")
    liquid_inj, staked_inj, errors = 0.0, 0.0, 0
    raw_tokens: list[tuple[str, int]] = []
    for address in addresses:
        encoded = quote(address, safe="")
        try:
            balances = _inj_get(f"/cosmos/bank/v1beta1/balances/{encoded}?pagination.limit=200")
            for coin in balances.get("balances") or []:
                if coin.get("denom") == "inj":
                    liquid_inj += int(coin.get("amount") or 0) / 1e18
                elif int(coin.get("amount") or 0) > 0:
                    raw_tokens.append((str(coin.get("denom") or ""), int(coin.get("amount") or 0)))
            stakes = _inj_get(f"/cosmos/staking/v1beta1/delegations/{encoded}?pagination.limit=200")
            staked_inj += sum(int((row.get("balance") or {}).get("amount") or 0) / 1e18
                              for row in stakes.get("delegation_responses") or []
                              if (row.get("balance") or {}).get("denom") == "inj")
            try:
                unbonding = _inj_get(f"/cosmos/staking/v1beta1/delegators/{encoded}/unbonding_delegations?pagination.limit=200")
                staked_inj += sum(int(entry.get("balance") or 0) / 1e18
                                  for row in unbonding.get("unbonding_responses") or []
                                  for entry in row.get("entries") or [])
            except CollectorError:
                errors += 1
            try:
                rewards = _inj_get(f"/cosmos/distribution/v1beta1/delegators/{encoded}/rewards")
                staked_inj += sum(float(coin.get("amount") or 0) / 1e18
                                  for coin in rewards.get("total") or [] if coin.get("denom") == "inj")
            except CollectorError:
                errors += 1
        except (CollectorError, ValueError, TypeError):
            errors += 1

    quantities: dict[str, float] = {"INJ": liquid_inj, "INJ (staked)": staked_inj}
    prices: dict[str, float] = {"INJ": price, "INJ (staked)": price}
    if raw_tokens:
        try:
            token_list = _request("https://raw.githubusercontent.com/InjectiveLabs/injective-lists/master/json/tokens/mainnet.json")
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
                data = _request("https://api.coingecko.com/api/v3/simple/price?" + urlencode({
                    "ids": ",".join(cg_ids), "vs_currencies": "usd",
                }))
                cg_prices = {key: float((value or {}).get("usd") or 0) for key, value in data.items()}
            except CollectorError:
                errors += 1
        dex = _dex_prices([str(item["address"]) for item in resolved if item["address"]])
        for item in resolved:
            if item["symbol"] in STABLE_SYMBOLS:
                token_price = 1.0
            elif item["coingecko"]:
                token_price = cg_prices.get(item["coingecko"], 0)
            else:
                token_price = dex.get(str(item["address"]).lower(), ("", 0))[1] if item["address"] else 0
            value = item["amount"] * token_price
            if value >= DUST_USD:
                quantities[item["symbol"]] = quantities.get(item["symbol"], 0.0) + item["amount"]
                prices[item["symbol"]] = token_price
    return _source("inj-wallet", "INJ", [
        _holding(symbol, quantity, prices.get(symbol, 0.0),
                 "cash" if symbol in STABLE_SYMBOLS else "invested")
        for symbol, quantity in quantities.items()
    ], errors, addresses)


SOL_RPC = ("https://api.mainnet.solana.com", "https://api.mainnet-beta.solana.com")
SOL_TOKEN_PROGRAMS = (
    "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
    "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
)
SOL_STABLES = {
    "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v": "USDC",
    "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB": "USDT",
}
PUMP_PROGRAM = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P"
PUMP_BONDING_CURVE_DISCRIMINATOR = bytes((23, 183, 248, 55, 96, 216, 172, 96))
PUMP_CURVE_CACHE_SECONDS = 30
JUP_MINT = "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN"
JUP_STAKE_URL = "https://api.jup.ag/portfolio/v1/staked-jup/"
JUP_STAKE_CACHE_SECONDS = 5 * 60
JUP_STAKE_REQUEST_SPACING_SECONDS = 1.05
JUP_LOCK_PROGRAM = "LocpQgucEQHbqNABEYvBvwoxCPsSbG91A1QaQhQQqjn"
JUP_LOCK_DISCRIMINATOR = bytes((244, 119, 183, 4, 73, 116, 135, 195))
SPL_TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
SPL_TOKEN_2022_PROGRAM = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"
SPL_ASSOCIATED_TOKEN_PROGRAM = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL"
_JUP_STAKE_CACHE: dict[str, tuple[float, dict[str, Any]]] = {}
_PUMP_CURVE_PRICE_CACHE: dict[str, tuple[float, int, float]] = {}

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
_SOL_SYMBOL_CACHE: dict[str, str] = {}

_BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"
_BASE58_INDEX = {character: index for index, character in enumerate(_BASE58_ALPHABET)}
_ED25519_P = 2 ** 255 - 19
_ED25519_D = (-121665 * pow(121666, _ED25519_P - 2, _ED25519_P)) % _ED25519_P
_ED25519_I = pow(2, (_ED25519_P - 1) // 4, _ED25519_P)


def _base58_decode(value: str) -> bytes:
    number = 0
    try:
        for character in value:
            number = number * 58 + _BASE58_INDEX[character]
    except KeyError:
        raise CollectorError("invalid Solana address") from None
    raw = number.to_bytes((number.bit_length() + 7) // 8, "big") if number else b""
    return b"\0" * (len(value) - len(value.lstrip("1"))) + raw


def _base58_encode(value: bytes) -> str:
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


def _solana_program_address(seeds: list[bytes], program: str) -> str:
    program_bytes = _base58_decode(program)
    if len(program_bytes) != 32 or any(len(seed) > 32 for seed in seeds):
        raise CollectorError("invalid Solana program address")
    for bump in range(255, -1, -1):
        candidate = hashlib.sha256(
            b"".join([*seeds, bytes((bump,)), program_bytes, b"ProgramDerivedAddress"])
        ).digest()
        if not _ed25519_is_on_curve(candidate):
            return _base58_encode(candidate)
    raise CollectorError("Solana program address unavailable")


# Quote assets a Pump curve can be paired with, besides native SOL (an
# all-zero quote_mint): mint -> (decimals, fixed USD price). USDC-paired
# coins launched in May 2026 (pump-public-docs, "USDC paired coins").
PUMP_STABLE_QUOTES = {
    "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v": (6, 1.0),  # USDC
    "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB": (6, 1.0),  # USDT
}


def _pump_curve_price(data: bytes, decimals: int, sol_price: float) -> float:
    """Return USD per whole token for an incomplete Pump curve (SOL-, USDC- or USDT-paired)."""
    if len(data) < 49 or data[:8] != PUMP_BONDING_CURVE_DISCRIMINATOR:
        return 0.0
    virtual_tokens, virtual_quote, _, _, _ = struct.unpack_from("<QQQQQ", data, 8)
    complete = bool(data[48])
    if complete or virtual_tokens <= 0 or virtual_quote <= 0:
        return 0.0
    # quote_mint was appended after creator + two flags. Missing means a
    # legacy SOL pair; an all-zero pubkey is also Pump's native-SOL marker.
    quote_mint = data[83:115] if len(data) >= 115 else b"\0" * 32
    if any(quote_mint):
        quote = PUMP_STABLE_QUOTES.get(_base58_encode(quote_mint))
        if not quote:
            return 0.0
        quote_decimals, quote_usd = quote
    else:
        quote_decimals, quote_usd = 9, sol_price
    token_units = virtual_tokens / (10 ** max(0, min(18, int(decimals))))
    quote_units = virtual_quote / (10 ** quote_decimals)
    return quote_units / token_units * quote_usd if token_units > 0 else 0.0


def _pump_curve_prices(mints: list[str], decimals: dict[str, int], sol_price: float) -> dict[str, float]:
    """Batch-price unlisted Pump tokens from their on-chain curve accounts."""
    now = time.monotonic()
    result: dict[str, float] = {}
    missing: list[str] = []
    for mint in dict.fromkeys(mints):
        cached = _PUMP_CURVE_PRICE_CACHE.get(mint)
        mint_decimals = int(decimals.get(mint, 0))
        if cached and cached[1] == mint_decimals and now - cached[0] < PUMP_CURVE_CACHE_SECONDS:
            if cached[2] > 0:
                result[mint] = cached[2]
        else:
            missing.append(mint)

    for start in range(0, len(missing), 100):
        chunk = missing[start:start + 100]
        addresses = [
            _solana_program_address([b"bonding-curve", _base58_decode(mint)], PUMP_PROGRAM)
            for mint in chunk
        ]
        response = _sol_rpc("getMultipleAccounts", [
            addresses, {"encoding": "base64", "commitment": "confirmed"},
        ])
        accounts = (response or {}).get("value") or []
        for index, mint in enumerate(chunk):
            account = accounts[index] if index < len(accounts) else None
            price = 0.0
            try:
                if account and account.get("owner") == PUMP_PROGRAM:
                    encoded = (account.get("data") or [""])[0]
                    price = _pump_curve_price(
                        base64.b64decode(encoded, validate=True), decimals.get(mint, 0), sol_price,
                    )
            except (ValueError, TypeError, struct.error):
                price = 0.0
            _PUMP_CURVE_PRICE_CACHE[mint] = (now, int(decimals.get(mint, 0)), price)
            if price > 0:
                result[mint] = price
    return result


def _sol_rpc(method: str, params: list[Any]) -> Any:
    for base in SOL_RPC:
        try:
            data = _post(base, {"jsonrpc": "2.0", "method": method, "params": params, "id": 1})
            if not data.get("error"):
                return data.get("result")
        except CollectorError:
            pass
    raise CollectorError("Solana RPC unavailable")


def _jupiter_staked_amount(address: str, api_key: Any = None) -> tuple[float, bool]:
    """Return total staked/unstaking JUP and whether stale cached data was used."""
    now = time.monotonic()
    cached = _JUP_STAKE_CACHE.get(address)
    if cached and now - cached[0] < JUP_STAKE_CACHE_SECONDS:
        data = cached[1]
        stale = False
    else:
        headers = {"x-api-key": str(api_key)} if api_key else {}
        try:
            data = _request(JUP_STAKE_URL + quote(address, safe=""), headers=headers)
            if not isinstance(data, dict):
                raise CollectorError("Jupiter staking response is invalid")
            _JUP_STAKE_CACHE[address] = (now, data)
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


def _jupiter_lock_positions(config: dict[str, Any]) -> list[dict[str, Any]]:
    """Read configured Jupiter Lock escrows and their exact token vault balances."""
    raw_locks = config.get("jupiter_locks") or []
    if isinstance(raw_locks, str):
        raw_locks = [raw_locks]
    escrows = list(dict.fromkeys(str(value).strip() for value in raw_locks if str(value).strip()))[:20]
    if not escrows:
        return []
    if any(len(_base58_decode(escrow)) != 32 for escrow in escrows):
        raise CollectorError("invalid Jupiter Lock escrow address")

    response = _sol_rpc("getMultipleAccounts", [
        escrows, {"encoding": "base64", "commitment": "confirmed"},
    ])
    accounts = (response or {}).get("value") or []
    decoded: list[dict[str, Any]] = []
    for index, escrow in enumerate(escrows):
        account = accounts[index] if index < len(accounts) else None
        try:
            if not account or account.get("owner") != JUP_LOCK_PROGRAM:
                raise CollectorError("Jupiter Lock escrow is unavailable")
            data = base64.b64decode((account.get("data") or [""])[0], validate=True)
            if len(data) != 296 or data[:8] != JUP_LOCK_DISCRIMINATOR:
                raise CollectorError("Jupiter Lock escrow data is invalid")
            token_program = SPL_TOKEN_2022_PROGRAM if data[139] == 1 else SPL_TOKEN_PROGRAM
            mint = _base58_encode(data[40:72])
            vault = _solana_program_address([
                _base58_decode(escrow), _base58_decode(token_program), data[40:72],
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
    vault_response = _sol_rpc("getMultipleAccounts", [
        vaults, {"encoding": "base64", "commitment": "confirmed"},
    ])
    mint_response = _sol_rpc("getMultipleAccounts", [
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


def collect_solana(config: dict[str, Any]) -> dict[str, Any]:
    addresses = _addresses(config)
    if not addresses:
        raise CollectorError("addresses not configured")
    sol_price = _asset_price("SOL", "solana")
    holdings: list[dict[str, Any]] = []
    raw_tokens: dict[tuple[str, str], tuple[float, int]] = {}
    errors = 0
    try:
        locked_positions = _jupiter_lock_positions(config)
    except CollectorError:
        locked_positions = []
        errors += 1
    for address in addresses:
        try:
            balance = _sol_rpc("getBalance", [address, {"commitment": "confirmed"}])
            sol_amount = float((balance or {}).get("value") or 0) / 1e9
            holdings.append(_holding(
                "SOL", sol_amount, sol_price, meta={"walletAddress": address},
                holding_id=f"{address}:native:SOL",
            ))
            for program in SOL_TOKEN_PROGRAMS:
                try:
                    result = _sol_rpc("getTokenAccountsByOwner", [
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
    mints = list({mint for _, mint in raw_tokens if mint} | {item["mint"] for item in locked_positions} | {JUP_MINT})
    decimals_by_mint = {mint: decimals for (_, mint), (_, decimals) in raw_tokens.items() if mint}
    decimals_by_mint.update({item["mint"]: item["decimals"] for item in locked_positions})
    mint_prices: dict[str, float] = {}
    symbols: dict[str, str] = {}
    headers = {"x-api-key": str(config["jupiter_api_key"])} if config.get("jupiter_api_key") else {}
    for start in range(0, len(mints), 50):
        chunk = mints[start:start + 50]
        try:
            data = _request("https://api.jup.ag/price/v3?" + urlencode({"ids": ",".join(chunk)}), headers=headers)
            for mint, item in data.items():
                token_price = float((item or {}).get("usdPrice") or 0)
                if token_price > 0:
                    mint_prices[mint] = token_price
        except (CollectorError, ValueError, TypeError):
            errors += 1
    unpriced_mints = [mint for mint in mints if mint not in mint_prices]
    if unpriced_mints:
        try:
            mint_prices.update(_pump_curve_prices(unpriced_mints, decimals_by_mint, sol_price))
        except CollectorError:
            errors += 1
    for start in range(0, len(mint_prices), 50):
        chunk = list(mint_prices)[start:start + 50]
        try:
            metadata = _request("https://api.jup.ag/tokens/v2/search?" + urlencode({"query": ",".join(chunk)}), headers=headers)
            for item in metadata if isinstance(metadata, list) else []:
                if item.get("id") and item.get("symbol"):
                    symbols[str(item["id"])] = str(item["symbol"])
                    _SOL_SYMBOL_CACHE[str(item["id"])] = str(item["symbol"])
        except CollectorError:
            errors += 1
    for (address, mint), (amount, _) in raw_tokens.items():
        symbol = SOL_STABLES.get(mint, symbols.get(mint) or _SOL_SYMBOL_CACHE.get(mint, mint[:6]))
        token_price = 1.0 if mint in SOL_STABLES else mint_prices.get(mint, 0)
        if amount * token_price >= DUST_USD:
            holdings.append(_holding(
                symbol, amount, token_price, "cash" if symbol in {"USDC", "USDT"} else "invested",
                meta={"walletAddress": address}, holding_id=f"{address}:token:{mint}",
            ))

    for lock in locked_positions:
        mint = lock["mint"]
        symbol = SOL_STABLES.get(mint, symbols.get(mint) or _SOL_SYMBOL_CACHE.get(mint, mint[:6]))
        token_price = 1.0 if mint in SOL_STABLES else mint_prices.get(mint, 0)
        if lock["quantity"] * token_price >= DUST_USD:
            holdings.append(_holding(
                f"{symbol} (locked)", lock["quantity"], token_price,
                meta={
                    "dapp": "Jupiter Lock", "protocolType": "Vesting",
                    "walletAddress": lock["escrow"], "lockEscrow": lock["escrow"],
                    "cliffTime": lock["cliff_time"], "vestingEnd": lock["vesting_end"],
                },
                holding_id=f"jupiter-lock:{lock['escrow']}",
            ))

    for index, address in enumerate(addresses):
        if index:
            time.sleep(JUP_STAKE_REQUEST_SPACING_SECONDS)
        try:
            amount, stale = _jupiter_staked_amount(address, config.get("jupiter_api_key"))
            jup_price = mint_prices.get(JUP_MINT, 0)
            if amount * jup_price >= DUST_USD:
                holdings.append(_holding(
                    "JUP (staked)", amount, jup_price,
                    meta={"walletAddress": address, "dapp": "Jupiter", "protocolType": "Staking"},
                    holding_id=f"{address}:stake:JUP",
                ))
            if stale:
                errors += 1
        except CollectorError:
            errors += 1
    return _source("solana-wallet", "SOL", holdings, errors)


HL_API = "https://api.hyperliquid.xyz/info"
HL_STABLE_SYMBOLS = {"USDC", "USDT", "USDHL"}

# spotMeta (the token/pair universe) barely ever changes, so it's fetched
# once per process rather than once per poll -- same reasoning as the
# Solana collector's _SOL_SYMBOL_CACHE above.
_HL_SPOT_META_CACHE: dict[str, Any] | None = None


def _hl_info(body: dict[str, Any]) -> Any:
    return _post(HL_API, body)


def _hl_spot_meta() -> dict[str, Any]:
    global _HL_SPOT_META_CACHE
    if _HL_SPOT_META_CACHE is None:
        try:
            _HL_SPOT_META_CACHE = _hl_info({"type": "spotMeta"})
        except CollectorError:
            _HL_SPOT_META_CACHE = {}
    return _HL_SPOT_META_CACHE


def _hl_spot_price(symbol: str, all_mids: dict[str, Any], spot_meta: dict[str, Any]) -> float:
    """allMids keys spot pairs inconsistently -- a few well-known ones by a
    friendly "TOKEN/USDC" name, most by "@{universe index}". Try both;
    if neither resolves, 0 is returned and the caller treats the holding
    as unpriced (still reported with its real quantity, just $0 value)
    rather than guessing at a number."""
    if symbol.upper() in HL_STABLE_SYMBOLS:
        return 1.0
    if not all_mids:
        return 0.0

    direct = all_mids.get(f"{symbol}/USDC")
    if direct is not None:
        try:
            price = float(direct)
            if price > 0:
                return price
        except (TypeError, ValueError):
            pass

    tokens = spot_meta.get("tokens") or []
    universe = spot_meta.get("universe") or []
    token_index = next((t.get("index") for t in tokens if t.get("name") == symbol), None)
    if token_index is not None:
        for pair in universe:
            pair_tokens = pair.get("tokens") or []
            if pair_tokens and pair_tokens[0] == token_index:
                raw = all_mids.get(f"@{pair.get('index')}")
                if raw is not None:
                    try:
                        price = float(raw)
                        if price > 0:
                            return price
                    except (TypeError, ValueError):
                        pass
    return 0.0


HL_FUNDING_WINDOW_MS = 24 * 60 * 60 * 1000


def _hl_funding_rates() -> dict[str, float]:
    """Current per-coin funding rate, keyed by coin name. metaAndAssetCtxs
    returns [meta, assetCtxs] as two parallel arrays -- assetCtxs[i]
    corresponds to meta['universe'][i], not to any id in assetCtxs itself,
    so the two have to be zipped together positionally."""
    try:
        meta, contexts = _hl_info({"type": "metaAndAssetCtxs"})
    except (CollectorError, ValueError, TypeError):
        return {}
    universe = meta.get("universe") or []
    rates: dict[str, float] = {}
    for entry, ctx in zip(universe, contexts or []):
        name = entry.get("name")
        funding = ctx.get("funding") if isinstance(ctx, dict) else None
        if name and funding is not None:
            try:
                rates[name] = float(funding)
            except (TypeError, ValueError):
                pass
    return rates


def _hl_funding_24h(address: str) -> dict[str, float]:
    """Net funding paid (negative) or received (positive) per coin over the
    last 24h, summed from individual funding events. Best-effort: an empty
    dict just means the Futures panel won't show a funding-24h figure this
    poll, not that the position data itself is wrong."""
    now_ms = int(time.time() * 1000)
    try:
        events = _hl_info({
            "type": "userFunding",
            "user": address,
            "startTime": now_ms - HL_FUNDING_WINDOW_MS,
            "endTime": now_ms,
        })
    except (CollectorError, ValueError, TypeError):
        return {}
    totals: dict[str, float] = {}
    for event in events or []:
        delta = event.get("delta") or {}
        coin = delta.get("coin")
        try:
            amount = float(delta.get("usdc") or 0)
        except (TypeError, ValueError):
            continue
        if coin:
            totals[coin] = totals.get(coin, 0.0) + amount
    return totals


def _hl_fees_24h(address: str) -> dict[str, float]:
    """Trading fees paid per coin over the last 24h, summed from recent
    fills. userFills only ever returns a bounded recent-history window (not
    the full account history), which is exactly the "last little while"
    figure this is after -- so no explicit time range is requested, just
    filtered down to the last 24h client-side."""
    now_ms = int(time.time() * 1000)
    try:
        fills = _hl_info({"type": "userFills", "user": address})
    except (CollectorError, ValueError, TypeError):
        return {}
    totals: dict[str, float] = {}
    for fill in fills or []:
        try:
            fill_time = int(fill.get("time") or 0)
        except (TypeError, ValueError):
            continue
        if fill_time < now_ms - HL_FUNDING_WINDOW_MS:
            continue
        coin = fill.get("coin")
        try:
            fee = float(fill.get("fee") or 0)
        except (TypeError, ValueError):
            continue
        if coin:
            totals[coin] = totals.get(coin, 0.0) + fee
    return totals


def collect_hyperliquid(config: dict[str, Any]) -> dict[str, Any]:
    """Hyperliquid wallet watcher: spot token balances, native Earn supply,
    and open perp positions, all keyed by a plain public wallet address -- no
    API key, Hyperliquid's Info API is read-only and keyless.

    Perp positions are the one place this collector does something the
    other collectors in this file don't: a leveraged position has no
    "amount of BTC you own" the way a spot balance does, so instead of
    quantity=contracts/price=mark-price (which would make server.py's
    flow-vs-market split think value moves 1:1 with the mark price, when
    under leverage it moves faster, and a margin add/remove would look
    like nothing happened at all) it reports:

        quantity = |position size|                 (contracts)
        price    = equity / quantity                (equity, not mark price)

    where equity = marginUsed + unrealizedPnl -- what closing the position
    right now would hand back. _holding() only ever cares that quantity and
    price are self-consistent (their product has to equal the value), not
    that price is literally a market price, so this makes resizing a
    position read as a deposit/withdrawal and the position's PnL swinging
    at an unchanged size read as market movement -- the same distinction
    daily-attribution.js draws for every other holding, applied here to
    something that doesn't have real spot units to begin with.

    Note: if more than one watched address holds the same coin's perp
    position, their quantities are summed and the later address's price
    (equity-per-contract) wins, same simplification the BSC/Solana
    collectors above already make for a token held at multiple addresses.
    That's exact for spot (same market price either way) but only
    approximate here, since two positions in the same coin can carry
    different leverage/PnL -- acceptable for the common case of watching
    a single trading wallet, worth revisiting if that stops being true.
    """
    addresses = _addresses(config)
    if not addresses:
        raise CollectorError("addresses not configured")
    wallet_address = addresses[0] if len(addresses) == 1 else None

    spot_meta = _hl_spot_meta()
    try:
        all_mids = _hl_info({"type": "allMids"})
    except CollectorError:
        all_mids = {}
    funding_rates = _hl_funding_rates()

    quantities: dict[str, float] = {}
    prices: dict[str, float] = {}
    kinds: dict[str, str] = {}
    metas: dict[str, dict[str, Any]] = {}
    earn_values: dict[str, float] = {}
    earn_bases: dict[str, float] = {}
    earn_market_prices: dict[str, float] = {}
    errors = 0

    token_names: dict[int, str] = {}
    for token in spot_meta.get("tokens") or []:
        try:
            token_names[int(token.get("index"))] = str(token.get("name") or "").strip()
        except (TypeError, ValueError):
            continue

    for address in addresses:
        try:
            spot = _hl_info({"type": "spotClearinghouseState", "user": address})
            for bal in spot.get("balances") or []:
                amount = float(bal.get("total") or 0)
                if amount <= 0:
                    continue
                symbol = str(bal.get("coin") or "").strip()
                if not symbol:
                    continue
                price = _hl_spot_price(symbol, all_mids, spot_meta)
                quantities[symbol] = quantities.get(symbol, 0.0) + amount
                prices[symbol] = price
                kinds[symbol] = "cash" if symbol.upper() in HL_STABLE_SYMBOLS else "invested"
                metas.setdefault(symbol, {"instrument": "spot"})
                if wallet_address:
                    metas[symbol]["walletAddress"] = wallet_address
        except (CollectorError, ValueError, TypeError):
            errors += 1

        try:
            # Hyperliquid's Earn page is backed by the native borrow/lend
            # supply state. `basis` is the supplied principal and `value` is
            # the current token amount after interest, so retaining both lets
            # portfolio attribution treat accrued yield as return instead of
            # as a new deposit. Earn belongs with the unified Perp account in
            # Atmos, not with freely held Spot tokens.
            earn = _hl_info({"type": "borrowLendUserState", "user": address})
            for pair in earn.get("tokenToState") or []:
                if not isinstance(pair, (list, tuple)) or len(pair) != 2:
                    continue
                token_index = int(pair[0])
                supply = (pair[1] or {}).get("supply") or {}
                current = max(0.0, float(supply.get("value") or 0))
                if current <= 0:
                    continue
                basis = max(0.0, float(supply.get("basis") or 0))
                symbol = token_names.get(token_index) or f"Token {token_index}"
                market_price = _hl_spot_price(symbol, all_mids, spot_meta)
                earn_symbol = f"{symbol} Earn"
                earn_values[earn_symbol] = earn_values.get(earn_symbol, 0.0) + current
                earn_bases[earn_symbol] = earn_bases.get(earn_symbol, 0.0) + basis
                earn_market_prices[earn_symbol] = market_price
        except (CollectorError, ValueError, TypeError, AttributeError):
            errors += 1

        try:
            perp = _hl_info({"type": "clearinghouseState", "user": address})
            # Confirmed directly against a live account (both the
            # Hyperliquid UI's own "Total Equity" and the raw API): this
            # wallet's spot USDC balance (added in the spotClearinghouseState
            # loop above) is not just idle cash sitting next to the perps
            # account -- Hyperliquid's unified cross-margin marks it
            # against open positions in real time, so it already carries
            # every open position's locked margin *and* floating
            # unrealized PnL. It's already the account's full net worth on
            # its own.
            #
            # Two earlier attempts at this got that backwards: first adding
            # `withdrawable`, then netting against clearinghouseState's own
            # `marginSummary.accountValue` -- both treated the perps side as
            # a second pool of money to reconcile against spot, when the
            # actual bug is simpler: spot USDC already covers the positions'
            # equity once, and then each position gets reported *again* as
            # its own holding a few lines down (for the Futures cards).
            # That's the double-count. The fix has nothing to do with any
            # field on this `perp` object -- it's applied to the spot USDC
            # total after the position loop below, by subtracting the
            # positions' own combined equity back out of it.

            open_coins = [
                str((ap.get("position") or {}).get("coin") or "")
                for ap in (perp.get("assetPositions") or [])
                if abs(float((ap.get("position") or {}).get("szi") or 0)) >= 1e-9
            ]
            # Funding/fee history is its own pair of API calls -- skip them
            # entirely when nothing is open, rather than spending two requests
            # on a wallet that's currently flat on perps.
            funding_24h = _hl_funding_24h(address) if open_coins else {}
            fees_24h = _hl_fees_24h(address) if open_coins else {}

            positions_equity = 0.0
            for entry in perp.get("assetPositions") or []:
                position = entry.get("position") or {}
                size = float(position.get("szi") or 0)
                if abs(size) < 1e-9:
                    continue
                coin = str(position.get("coin") or "?")
                entry_px = float(position.get("entryPx") or 0)
                position_value = float(position.get("positionValue") or 0)
                margin_used = float(position.get("marginUsed") or 0)
                unrealized = float(position.get("unrealizedPnl") or 0)
                liquidation_px = position.get("liquidationPx")
                leverage = (position.get("leverage") or {}).get("value")
                quantity = abs(size)
                mark_px = position_value / quantity if quantity > 0 else None
                equity = max(0.0, margin_used + unrealized)
                positions_equity += equity

                symbol = f"{coin} Perp"
                quantities[symbol] = quantities.get(symbol, 0.0) + quantity
                prices[symbol] = equity / quantity if quantity > 0 else 0.0
                kinds[symbol] = "invested"
                metas[symbol] = {
                    "instrument": "perp",
                    **({"walletAddress": wallet_address} if wallet_address else {}),
                    "side": "long" if size >= 0 else "short",
                    "leverage": leverage,
                    "entryPrice": entry_px or None,
                    "markPrice": mark_px,
                    "liquidationPrice": float(liquidation_px) if liquidation_px not in (None, "") else None,
                    # Notional exposure (size x mark price) -- what the
                    # position is actually worth/moving on, as opposed to
                    # marginUsed (what's locked up as collateral for it) or
                    # the holding's own "value" (marginUsed + unrealizedPnl,
                    # the equity you'd walk away with -- see the file-level
                    # docstring for why that one specifically has to stay
                    # equity-based). The Futures panel shows this instead of
                    # marginUsed since it's the number that actually answers
                    # "how much BTC exposure am I carrying".
                    "positionValue": position_value or None,
                    "marginUsed": margin_used,
                    "unrealizedPnl": unrealized,
                    "fundingRate": funding_rates.get(coin),
                    "funding24h": funding_24h.get(coin),
                    "fees24h": fees_24h.get(coin),
                }

            # Positions' combined equity is already carried inside the spot
            # USDC balance (see comment above) -- net it back out so it
            # isn't also counted via each position's own holding below.
            if positions_equity > 0:
                quantities["USDC"] = max(0.0, quantities.get("USDC", 0.0) - positions_equity)
                prices.setdefault("USDC", 1.0)
                kinds["USDC"] = "cash"
                # Marked so the frontend can route this out of the shared
                # cross-source "USDC" row in Spot (see totals.js's
                # getPortfolioComposition) -- this figure is specifically
                # what's left of THIS unified Hyperliquid account once its
                # open positions' equity is set aside, not free cash that
                # belongs lumped in with plain USDC held on Binance/Solana/
                # etc. It's still fully counted in the grand total (that
                # comes from the source's own `value`, not from this map)
                # and still shown, just via the Futures accordion's own
                # header total instead (see totals.js's
                # getFuturesSourceTotal). Idle collateral keeps this label too.
                metas["USDC"] = {"instrument": "perp-cash", **({"walletAddress": wallet_address} if wallet_address else {})}
        except (CollectorError, ValueError, TypeError):
            errors += 1

    # Unified-account collateral remains Perp even when every position is closed.
    if "USDC" in quantities:
        metas["USDC"] = {"instrument": "perp-cash", **({"walletAddress": wallet_address} if wallet_address else {})}
    holdings = [
        _holding(symbol, quantity, prices.get(symbol, 0.0), kinds.get(symbol, "invested"),
                 meta=metas.get(symbol))
        for symbol, quantity in quantities.items()
    ]
    for symbol, current in earn_values.items():
        basis = earn_bases.get(symbol, 0.0)
        quantity = basis if basis > 0 else current
        market_price = earn_market_prices.get(symbol, 0.0)
        price = market_price * current / quantity if quantity > 0 else 0.0
        token_symbol = symbol.removesuffix(" Earn")
        holdings.append(_holding(
            symbol, quantity, price,
            "cash" if token_symbol.upper() in HL_STABLE_SYMBOLS else "invested",
            meta={"instrument": "perp-cash", "account": "earn", **({"walletAddress": wallet_address} if wallet_address else {})},
        ))
    return _source("hyperliquid-wallet", "HL", holdings, errors)


def collect_monero(config: dict[str, Any]) -> dict[str, Any]:
    # Binance no longer supplies the live XMR market used by this collector.
    # Route Monero directly through CoinGecko instead of waiting for a failed
    # Binance request or accepting a stale exchange response.
    price = _coingecko_price("monero")
    try:
        total_xmr = max(0.0, float(config.get("amount") or 0))
    except (ValueError, TypeError):
        raise CollectorError("manual Monero amount is invalid") from None
    return _source("monero-wallet", "XMR", [_holding("XMR", total_xmr, price)])


COLLECTORS = {
    "binance-spot": collect_binance,
    "aptos-wallet": collect_aptos,
    "arbitrum-wallet": collect_arbitrum,
    "bsc-wallet": collect_bsc,
    "cardano-wallet": collect_cardano,
    "hyperliquid-wallet": collect_hyperliquid,
    "inj-wallet": collect_injective,
    "monero-wallet": collect_monero,
    "solana-wallet": collect_solana,
}


def load_config(path: str) -> dict[str, Any]:
    try:
        data = json.loads(Path(path).read_text(encoding="utf-8"))
    except FileNotFoundError:
        raise CollectorError("source configuration is missing") from None
    except (OSError, json.JSONDecodeError):
        raise CollectorError("source configuration is invalid") from None
    if not isinstance(data, dict) or not isinstance(data.get("sources", {}), dict):
        raise CollectorError("source configuration is invalid")
    return data


def configured_sources(config: dict[str, Any]) -> dict[str, dict[str, Any]]:
    return {source_id: values for source_id, values in config.get("sources", {}).items()
            if source_id in COLLECTORS and isinstance(values, dict) and values.get("enabled", True)}


def collect_once(config: dict[str, Any], db_path: str) -> dict[str, Any]:
    active = configured_sources(config)
    if not active:
        return {"skipped": True, "reason": "no enabled sources"}
    previous = server.latest(db_path)
    previous_sources = {item["source_id"]: item for item in previous.get("sources", [])}
    previous_holdings: dict[str, list[dict[str, Any]]] = {}
    for item in previous.get("holdings", []):
        previous_holdings.setdefault(item["source_id"], []).append({
            "id": item["holding_id"],
            "symbol": item["symbol"], "value": item["value"], "kind": item["kind"],
            "quantity": item.get("quantity", item["value"]), "price": item.get("price", 1.0),
            "meta": item.get("meta"),
        })

    results: dict[str, dict[str, Any]] = {}
    if active:
        with ThreadPoolExecutor(max_workers=min(4, len(active)), thread_name_prefix="collector") as pool:
            futures = {pool.submit(COLLECTORS[source_id], values): source_id for source_id, values in active.items()}
            for future in as_completed(futures):
                source_id = futures[future]
                try:
                    result = future.result()
                    old = previous_sources.get(source_id)
                    if result.get("error_count", 0) and old:
                        result = {
                            "id": source_id,
                            "label": old.get("label") or result["label"],
                            "value": float(old.get("value") or 0),
                            "error_count": int(old.get("error_count") or 0) + int(result["error_count"]),
                            "holdings": previous_holdings.get(source_id, []),
                        }
                    results[source_id] = result
                except Exception as exc:
                    old = previous_sources.get(source_id, {})
                    results[source_id] = {
                        "id": source_id,
                        "label": old.get("label") or source_id,
                        "value": float(old.get("value") or 0),
                        "error_count": 1,
                        "holdings": previous_holdings.get(source_id, []),
                    }
                    print(f"collector {source_id} failed: {type(exc).__name__}", file=sys.stderr, flush=True)

    frame = {"ts_ms": int(time.time() * 1000), "currency": "USD", "sources": list(results.values())}
    return server.ingest(db_path, frame)


def _prune(db_path: str) -> None:
    try:
        result = server.prune(db_path)
        if result["deleted"]:
            print(f"retention: removed {result['deleted']} old holdings rows", file=sys.stderr, flush=True)
    except Exception as exc:  # retention must never stop collection
        print(f"retention failed: {type(exc).__name__}: {exc}", file=sys.stderr, flush=True)


def run(config_path: str, db_path: str, once: bool = False) -> None:
    last_prune = None
    while True:
        started = time.monotonic()
        config = load_config(config_path)
        collect_once(config, db_path)
        if once:
            return
        if last_prune is None or started - last_prune >= server.PRUNE_INTERVAL_SECONDS:
            last_prune = started
            _prune(db_path)
        poll_seconds = max(30, int(config.get("poll_seconds") or DEFAULT_POLL_SECONDS))
        time.sleep(max(1, poll_seconds - (time.monotonic() - started)))


def print_status(db_path: str) -> None:
    with server.connect(db_path) as db:
        rows = db.execute(
            """SELECT s.source_id, s.error_count, COUNT(h.symbol) AS holdings
               FROM source_status s
               LEFT JOIN current_holdings h ON h.source_id = s.source_id
               GROUP BY s.source_id, s.error_count
               ORDER BY s.source_id"""
        ).fetchall()
        samples = db.execute("SELECT COUNT(*) FROM portfolio_samples").fetchone()[0]
    print(json.dumps({
        "sources": [
            {"source": row["source_id"], "errors": row["error_count"], "holdings": row["holdings"]}
            for row in rows
        ],
        "samples": samples,
    }, separators=(",", ":")))


def main() -> None:
    db_path = os.environ.get("ATMOS_PORTFOLIO_DB", server.DEFAULT_DB)
    if "--status" in sys.argv:
        print_status(db_path)
    else:
        run(
            os.environ.get("ATMOS_PORTFOLIO_SOURCES", DEFAULT_CONFIG),
            db_path,
            "--once" in sys.argv,
        )


if __name__ == "__main__":
    main()
