"""The shapes a connector reports: holdings, what one collection found, and
the source the runner builds from it."""

from __future__ import annotations

from typing import Any

DUST_USD = 0.01


def addresses(config: dict[str, Any], key: str = "addresses") -> list[str]:
    """A configured address list, trimmed and de-duplicated (strings or {address}/{addr} objects)."""
    result: list[str] = []
    raw = config.get(key) or []
    if isinstance(raw, str):
        raw = [raw]
    for item in raw:
        value = item if isinstance(item, str) else item.get("address", item.get("addr", ""))
        value = str(value).strip()
        if value and value not in result:
            result.append(value)
    return result


def holding(symbol: str, quantity: float, price: float, kind: str = "invested",
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


def collected(holdings: list[dict[str, Any]], errors: int = 0,
              wallet_addresses: list[str] | None = None) -> dict[str, Any]:
    """What a connector's collect() returns. It doesn't name the source: the
    runner does, from the configuration, so one connector can serve several."""
    return {"holdings": holdings, "errors": max(0, int(errors)), "wallet_addresses": wallet_addresses or []}


def build_source(source_id: str, label: str, dimensions: dict[str, Any], result: dict[str, Any]) -> dict[str, Any]:
    """The source sent to server.ingest(): the connector's holdings, with its
    dimensions (dapp, chain, ...) as defaults under each holding's own meta."""
    wallet_addresses = result.get("wallet_addresses") or []
    # A cross-margin perp can remain open after its position-local
    # marginUsed + unrealizedPnl falls to zero. Its loss is covered by the
    # account's shared collateral, so a zero equity value does not mean the
    # position is closed. Keep those rows for the Futures UI; ordinary
    # zero-value holdings are still dust and remain omitted.
    holdings = [
        item for item in result.get("holdings") or []
        if item["value"] > 0 or (
            (item.get("meta") or {}).get("instrument") == "perp"
            and item.get("quantity", 0) > 0
        )
    ]
    for item in holdings:
        own = item.get("meta") or {}
        meta = {**dimensions, **own}
        if not meta.get("walletAddress") and wallet_addresses:
            meta["walletAddress"] = wallet_addresses[0] if len(wallet_addresses) == 1 else "Multiple wallets"
        if meta.get("account") == "earn":
            meta["protocolType"] = "Lending"
        elif own.get("protocolType"):
            pass  # the connector said what this holding is
        elif "staked" in str(item.get("symbol") or "").lower():
            meta["protocolType"] = "Staking"
            if meta.get("dapp") == "Wallet":
                meta["dapp"] = f"{meta.get('chain', 'Native')} Staking"
        elif meta.get("instrument") in ("perp", "perp-cash"):
            meta["protocolType"] = meta.get("protocolType") or "Perpetuals"
        item["meta"] = meta or None
    return {
        "id": source_id,
        "label": label,
        "value": sum(item["value"] for item in holdings),
        "error_count": max(0, int(result.get("errors") or 0)),
        "holdings": holdings,
    }
