"""Hyperliquid accounts, from a public wallet address: spot balances, native
Earn supply, and open perp positions (Hyperliquid's Info API is read-only
and needs no key)."""

from __future__ import annotations

import time
from typing import Any

from ..shared import CollectorError, addresses, collected, holding, http

CONNECTOR = {
    "type": "hyperliquid",
    "name": "Hyperliquid",
    "label": "Hyperliquid",
    "legacy_id": "hyperliquid-wallet",
    "fields": [
        {"key": "addresses", "kind": "addresses", "required": True, "prompt": "Hyperliquid addresses"},
    ],
    "dimensions": {"dapp": "Hyperliquid", "protocolType": "Perpetuals", "exchange": "Hyperliquid", "chain": "Hyperliquid L1"},
    # Balances Finance includes or leaves out as a whole (a holding's meta.group):
    # the unified Perp account (collateral and positions), and Earn supply.
    "groups": [{"id": "perp", "label": "Perp"}, {"id": "earn", "label": "Earn"}],
}

API = "https://api.hyperliquid.xyz/info"
STABLE_SYMBOLS = {"USDC", "USDT", "USDHL"}

# spotMeta (the token/pair universe) barely ever changes, so it's fetched
# once per process rather than once per poll -- same reasoning as the
# Solana connector's SYMBOL_CACHE.
_SPOT_META_CACHE: dict[str, Any] | None = None


def _info(body: dict[str, Any]) -> Any:
    return http.post(API, body)


def _spot_meta() -> dict[str, Any]:
    global _SPOT_META_CACHE
    if _SPOT_META_CACHE is None:
        try:
            _SPOT_META_CACHE = _info({"type": "spotMeta"})
        except CollectorError:
            _SPOT_META_CACHE = {}
    return _SPOT_META_CACHE


def _spot_price(symbol: str, all_mids: dict[str, Any], spot_meta: dict[str, Any]) -> float:
    """allMids keys spot pairs inconsistently -- a few well-known ones by a
    friendly "TOKEN/USDC" name, most by "@{universe index}". Try both;
    if neither resolves, 0 is returned and the caller treats the holding
    as unpriced (still reported with its real quantity, just $0 value)
    rather than guessing at a number."""
    if symbol.upper() in STABLE_SYMBOLS:
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


FUNDING_WINDOW_MS = 24 * 60 * 60 * 1000


def _funding_rates() -> dict[str, float]:
    """Current per-coin funding rate, keyed by coin name. metaAndAssetCtxs
    returns [meta, assetCtxs] as two parallel arrays -- assetCtxs[i]
    corresponds to meta['universe'][i], not to any id in assetCtxs itself,
    so the two have to be zipped together positionally."""
    try:
        meta, contexts = _info({"type": "metaAndAssetCtxs"})
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


def _funding_24h(address: str) -> dict[str, float]:
    """Net funding paid (negative) or received (positive) per coin over the
    last 24h, summed from individual funding events. Best-effort: an empty
    dict just means the Futures panel won't show a funding-24h figure this
    poll, not that the position data itself is wrong."""
    now_ms = int(time.time() * 1000)
    try:
        events = _info({
            "type": "userFunding",
            "user": address,
            "startTime": now_ms - FUNDING_WINDOW_MS,
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


def _fees_24h(address: str) -> dict[str, float]:
    """Trading fees paid per coin over the last 24h, summed from recent
    fills. userFills only ever returns a bounded recent-history window (not
    the full account history), which is exactly the "last little while"
    figure this is after -- so no explicit time range is requested, just
    filtered down to the last 24h client-side."""
    now_ms = int(time.time() * 1000)
    try:
        fills = _info({"type": "userFills", "user": address})
    except (CollectorError, ValueError, TypeError):
        return {}
    totals: dict[str, float] = {}
    for fill in fills or []:
        try:
            fill_time = int(fill.get("time") or 0)
        except (TypeError, ValueError):
            continue
        if fill_time < now_ms - FUNDING_WINDOW_MS:
            continue
        coin = fill.get("coin")
        try:
            fee = float(fill.get("fee") or 0)
        except (TypeError, ValueError):
            continue
        if coin:
            totals[coin] = totals.get(coin, 0.0) + fee
    return totals


def collect(config: dict[str, Any]) -> dict[str, Any]:
    """Hyperliquid wallet watcher: spot token balances, native Earn supply,
    and open perp positions, all keyed by a plain public wallet address -- no
    API key, Hyperliquid's Info API is read-only and keyless.

    Perp positions are the one place this collector does something the
    other connectors don't: a leveraged position has no
    "amount of BTC you own" the way a spot balance does, so instead of
    quantity=contracts/price=mark-price (which would make server.py's
    flow-vs-market split think value moves 1:1 with the mark price, when
    under leverage it moves faster, and a margin add/remove would look
    like nothing happened at all) it reports:

        quantity = |position size|                 (contracts)
        price    = equity / quantity                (equity, not mark price)

    where equity = marginUsed + unrealizedPnl -- what closing the position
    right now would hand back. holding() only ever cares that quantity and
    price are self-consistent (their product has to equal the value), not
    that price is literally a market price, so this makes resizing a
    position read as a deposit/withdrawal and the position's PnL swinging
    at an unchanged size read as market movement -- the same distinction
    daily-attribution.js draws for every other holding, applied here to
    something that doesn't have real spot units to begin with.

    Note: if more than one watched address holds the same coin's perp
    position, their quantities are summed and the later address's price
    (equity-per-contract) wins, same simplification the BSC/Solana
    connectors already make for a token held at multiple addresses.
    That's exact for spot (same market price either way) but only
    approximate here, since two positions in the same coin can carry
    different leverage/PnL -- acceptable for the common case of watching
    a single trading wallet, worth revisiting if that stops being true.
    """
    watched = addresses(config)
    if not watched:
        raise CollectorError("addresses not configured")
    wallet_address = watched[0] if len(watched) == 1 else None

    spot_meta = _spot_meta()
    try:
        all_mids = _info({"type": "allMids"})
    except CollectorError:
        all_mids = {}
    funding_rates = _funding_rates()

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

    for address in watched:
        try:
            spot = _info({"type": "spotClearinghouseState", "user": address})
            for bal in spot.get("balances") or []:
                amount = float(bal.get("total") or 0)
                if amount <= 0:
                    continue
                symbol = str(bal.get("coin") or "").strip()
                if not symbol:
                    continue
                price = _spot_price(symbol, all_mids, spot_meta)
                quantities[symbol] = quantities.get(symbol, 0.0) + amount
                prices[symbol] = price
                kinds[symbol] = "cash" if symbol.upper() in STABLE_SYMBOLS else "invested"
                # Held on Hyperliquid's exchange, not in the Perp account.
                metas.setdefault(symbol, {"instrument": "spot", "protocolType": "Exchange"})
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
            earn = _info({"type": "borrowLendUserState", "user": address})
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
                market_price = _spot_price(symbol, all_mids, spot_meta)
                earn_symbol = f"{symbol} Earn"
                earn_values[earn_symbol] = earn_values.get(earn_symbol, 0.0) + current
                earn_bases[earn_symbol] = earn_bases.get(earn_symbol, 0.0) + basis
                earn_market_prices[earn_symbol] = market_price
        except (CollectorError, ValueError, TypeError, AttributeError):
            errors += 1

        try:
            perp = _info({"type": "clearinghouseState", "user": address})
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
            funding_24h = _funding_24h(address) if open_coins else {}
            fees_24h = _fees_24h(address) if open_coins else {}

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
                    "instrument": "perp", "group": "perp",
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
                metas["USDC"] = {"instrument": "perp-cash", "group": "perp", **({"walletAddress": wallet_address} if wallet_address else {})}
        except (CollectorError, ValueError, TypeError):
            errors += 1

    # Unified-account collateral remains Perp even when every position is closed.
    if "USDC" in quantities:
        metas["USDC"] = {"instrument": "perp-cash", "group": "perp", **({"walletAddress": wallet_address} if wallet_address else {})}
    holdings = [
        holding(symbol, quantity, prices.get(symbol, 0.0), kinds.get(symbol, "invested"),
                 meta=metas.get(symbol))
        for symbol, quantity in quantities.items()
    ]
    for symbol, current in earn_values.items():
        basis = earn_bases.get(symbol, 0.0)
        quantity = basis if basis > 0 else current
        market_price = earn_market_prices.get(symbol, 0.0)
        price = market_price * current / quantity if quantity > 0 else 0.0
        token_symbol = symbol.removesuffix(" Earn")
        holdings.append(holding(
            symbol, quantity, price,
            "cash" if token_symbol.upper() in STABLE_SYMBOLS else "invested",
            meta={"instrument": "perp-cash", "account": "earn", "group": "earn", **({"walletAddress": wallet_address} if wallet_address else {})},
        ))
    return collected(holdings, errors)
