#!/usr/bin/env python3
"""Small, dependency-free portfolio history API for a single-user VPS."""

from __future__ import annotations

import argparse
import base64
import hashlib
import hmac
import ipaddress
import json
import os
import re
import secrets
import sqlite3
import sys
import threading
import time
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

VERSION = "0.10.0"
API_VERSION = 1
PAIRING_PREFIX = "atmos-finance:"
DEFAULT_DB = "/var/lib/atmos-portfolio/portfolio.sqlite3"
MAX_HISTORY_ROWS = 10_000
# At most this many rows in one /v1/holdings-history answer: about 40 MB of
# Python while it's built, under the service's 160 MB (0.9.0 allowed 50,000;
# two such answers at once had the service killed for memory). Finance 1.1
# reads one poll at a time (a few hundred rows).
MAX_HOLDINGS_HISTORY_ROWS = 20_000
# The history and holdings-history answers are built one at a time: they're
# what takes the memory and the CPU, and the service has a quarter of one.
HEAVY_ROUTES = frozenset({"/v1/history", "/v1/holdings-history"})
_heavy = threading.BoundedSemaphore(1)
# Timestamps per query when reading the holdings behind chosen samples.
SAMPLES_PER_QUERY = 500
RESOLUTIONS_MS = {"raw": 0, "5m": 300_000, "1h": 3_600_000, "1d": 86_400_000}
HOUR_MS = 3_600_000
DAY_MS = 86_400_000
# holdings_history retention. Finance asks for raw and 5-minute points only
# within the last 30 days, hourly up to a year and daily beyond, so keeping
# every poll for RAW_DAYS, then the last poll of each hour until
# HOURLY_DAYS, then the last poll of each day changes nothing it shows.
# Overridable with ATMOS_PORTFOLIO_RAW_DAYS / ATMOS_PORTFOLIO_HOURLY_DAYS;
# ATMOS_PORTFOLIO_RETENTION=off keeps everything.
DEFAULT_RAW_DAYS = 30
DEFAULT_HOURLY_DAYS = 365
PRUNE_INTERVAL_SECONDS = 6 * 3600
# Paired devices: each has its own token, kept here only as a SHA-256 hash
# (the tokens are random, so a plain hash is enough), and can be revoked on
# its own. last_used_ms is written at most once a minute per device.
DEVICE_NAME = re.compile(r"^[A-Za-z0-9][A-Za-z0-9 ._-]{0,47}$")
LAST_USED_EVERY_MS = 60_000
MAX_TOKEN_CHARS = 256
SHARED_TOKEN_DEVICE = "shared token"


class ClosingConnection(sqlite3.Connection):
    def __exit__(self, *args):
        try:
            return super().__exit__(*args)
        finally:
            self.close()


def connect(db_path: str) -> sqlite3.Connection:
    db = sqlite3.connect(db_path, timeout=10, factory=ClosingConnection)
    db.row_factory = sqlite3.Row
    db.execute("PRAGMA journal_mode=WAL")
    db.execute("PRAGMA synchronous=NORMAL")
    db.execute("PRAGMA foreign_keys=ON")
    db.execute("PRAGMA busy_timeout=10000")
    return db


def _column_names(db: sqlite3.Connection, table: str) -> set[str]:
    return {row["name"] for row in db.execute(f"PRAGMA table_info({table})")}


def _has_table(db: sqlite3.Connection, table: str) -> bool:
    return db.execute("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?", (table,)).fetchone() is not None


def migrate(db_path: str) -> None:
    Path(db_path).parent.mkdir(parents=True, exist_ok=True)
    with connect(db_path) as db:
        db.executescript(
            """
            CREATE TABLE IF NOT EXISTS portfolio_samples (
              ts_ms INTEGER PRIMARY KEY,
              total REAL NOT NULL CHECK(total >= 0),
              invested REAL NOT NULL CHECK(invested >= 0),
              cash REAL NOT NULL CHECK(cash >= 0),
              currency TEXT NOT NULL,
              error_count INTEGER NOT NULL DEFAULT 0 CHECK(error_count >= 0)
            );
            CREATE TABLE IF NOT EXISTS current_holdings (
              source_id TEXT NOT NULL,
              holding_id TEXT NOT NULL,
              symbol TEXT NOT NULL,
              kind TEXT NOT NULL CHECK(kind IN ('invested', 'cash')),
              value REAL NOT NULL CHECK(value >= 0),
              currency TEXT NOT NULL,
              updated_at_ms INTEGER NOT NULL,
              PRIMARY KEY(source_id, holding_id)
            ) WITHOUT ROWID;
            -- meta is added below via ALTER TABLE (it postdates quantity/price,
            -- same upgrade-in-place approach) so existing installs don't need
            -- their whole table dropped for one nullable column.
            CREATE TABLE IF NOT EXISTS source_status (
              source_id TEXT PRIMARY KEY,
              label TEXT NOT NULL,
              value REAL NOT NULL CHECK(value >= 0),
              currency TEXT NOT NULL,
              updated_at_ms INTEGER NOT NULL,
              error_count INTEGER NOT NULL DEFAULT 0 CHECK(error_count >= 0)
            ) WITHOUT ROWID;
            CREATE INDEX IF NOT EXISTS portfolio_samples_ts
              ON portfolio_samples(ts_ms);

            -- Historized per-symbol snapshots. current_holdings only ever
            -- keeps the latest state; this table retains every poll so past
            -- point-in-time positions can be reconstructed.
            CREATE TABLE IF NOT EXISTS holdings_history (
              ts_ms INTEGER NOT NULL,
              source_id TEXT NOT NULL,
              holding_id TEXT NOT NULL,
              symbol TEXT NOT NULL,
              kind TEXT NOT NULL CHECK(kind IN ('invested', 'cash')),
              quantity REAL NOT NULL CHECK(quantity >= 0),
              price REAL NOT NULL CHECK(price >= 0),
              value REAL NOT NULL CHECK(value >= 0),
              currency TEXT NOT NULL,
              PRIMARY KEY(ts_ms, source_id, holding_id)
            ) WITHOUT ROWID;
            CREATE INDEX IF NOT EXISTS holdings_history_lookup
              ON holdings_history(source_id, symbol, ts_ms);
            """
        )
        # current_holdings predates quantity/price tracking. Add the columns
        # in place rather than dropping history on upgrade.
        existing = _column_names(db, "current_holdings")
        if "quantity" not in existing:
            db.execute("ALTER TABLE current_holdings ADD COLUMN quantity REAL NOT NULL DEFAULT 0")
        if "price" not in existing:
            db.execute("ALTER TABLE current_holdings ADD COLUMN price REAL NOT NULL DEFAULT 0")
        if "meta" not in existing:
            # Opaque per-holding JSON (funding rate, leverage, liquidation
            # price, ...) that a specific collector wants to attach without
            # every other collector/consumer needing to know its shape.
            # Nullable: absent for the vast majority of holdings, which have
            # nothing beyond symbol/kind/value/quantity/price to report.
            db.execute("ALTER TABLE current_holdings ADD COLUMN meta TEXT")

        # Holdings used to be keyed only by source/symbol/kind, which forced
        # collectors to merge the same token held by multiple wallets. A
        # stable holding_id retains account identity for counterparty and
        # wallet-allocation views while keeping old rows intact on upgrade.
        # Each rebuild is one transaction: stopped part-way, it never happened.
        if "holding_id" not in _column_names(db, "current_holdings"):
            db.executescript(
                """
                BEGIN;
                ALTER TABLE current_holdings RENAME TO current_holdings_legacy;
                CREATE TABLE current_holdings (
                  source_id TEXT NOT NULL, holding_id TEXT NOT NULL, symbol TEXT NOT NULL,
                  kind TEXT NOT NULL CHECK(kind IN ('invested', 'cash')),
                  value REAL NOT NULL CHECK(value >= 0), currency TEXT NOT NULL,
                  updated_at_ms INTEGER NOT NULL, quantity REAL NOT NULL DEFAULT 0,
                  price REAL NOT NULL DEFAULT 0, meta TEXT,
                  PRIMARY KEY(source_id, holding_id)
                ) WITHOUT ROWID;
                INSERT INTO current_holdings
                  (source_id,holding_id,symbol,kind,value,currency,updated_at_ms,quantity,price,meta)
                SELECT source_id,symbol || ':' || kind,symbol,kind,value,currency,updated_at_ms,quantity,price,meta
                FROM current_holdings_legacy;
                DROP TABLE current_holdings_legacy;
                COMMIT;
                """
            )
        # Up to 0.9.1 each statement of a rebuild was its own transaction, so
        # one stopped part-way left the rows in *_legacy beside a new table,
        # perhaps empty, that hid them for good. Bring them back: a source's
        # current holdings only if it has none since, history rows unless
        # that time of that holding is already there.
        if _has_table(db, "current_holdings_legacy"):
            db.executescript(
                """
                BEGIN;
                INSERT INTO current_holdings
                  (source_id,holding_id,symbol,kind,value,currency,updated_at_ms,quantity,price,meta)
                SELECT source_id,symbol || ':' || kind,symbol,kind,value,currency,updated_at_ms,quantity,price,meta
                FROM current_holdings_legacy
                WHERE source_id NOT IN (SELECT source_id FROM current_holdings);
                DROP TABLE current_holdings_legacy;
                COMMIT;
                """
            )

        for table in ("portfolio_samples", "source_status"):
            columns = _column_names(db, table)
            for column in ("spot", "perp"):
                if column not in columns:
                    db.execute(f"ALTER TABLE {table} ADD COLUMN {column} REAL")
        if "meta" not in _column_names(db, "holdings_history"):
            db.execute("ALTER TABLE holdings_history ADD COLUMN meta TEXT")
        if "holding_id" not in _column_names(db, "holdings_history"):
            db.executescript(
                """
                BEGIN;
                ALTER TABLE holdings_history RENAME TO holdings_history_legacy;
                CREATE TABLE holdings_history (
                  ts_ms INTEGER NOT NULL, source_id TEXT NOT NULL, holding_id TEXT NOT NULL,
                  symbol TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('invested', 'cash')),
                  quantity REAL NOT NULL CHECK(quantity >= 0), price REAL NOT NULL CHECK(price >= 0),
                  value REAL NOT NULL CHECK(value >= 0), currency TEXT NOT NULL, meta TEXT,
                  PRIMARY KEY(ts_ms, source_id, holding_id)
                ) WITHOUT ROWID;
                INSERT INTO holdings_history
                  (ts_ms,source_id,holding_id,symbol,kind,quantity,price,value,currency,meta)
                SELECT ts_ms,source_id,symbol || ':' || kind,symbol,kind,quantity,price,value,currency,meta
                FROM holdings_history_legacy;
                DROP TABLE holdings_history_legacy;
                COMMIT;
                """
            )
        if _has_table(db, "holdings_history_legacy"):
            db.executescript(
                """
                BEGIN;
                INSERT OR IGNORE INTO holdings_history
                  (ts_ms,source_id,holding_id,symbol,kind,quantity,price,value,currency,meta)
                SELECT ts_ms,source_id,symbol || ':' || kind,symbol,kind,quantity,price,value,currency,meta
                FROM holdings_history_legacy;
                DROP TABLE holdings_history_legacy;
                COMMIT;
                """
            )
        db.execute("CREATE INDEX IF NOT EXISTS holdings_history_lookup ON holdings_history(source_id, symbol, ts_ms)")
        # Every poll whose holdings were recorded, held or not: an empty
        # portfolio has no holdings_history rows, so without this it can't be
        # told from no poll. Thinned with holdings_history. On upgrade, the
        # polls before are the times holdings_history has (made under the
        # write lock, so a second start at once finds it made, not fails).
        if not _has_table(db, "holdings_polls"):
            db.executescript(
                """
                BEGIN IMMEDIATE;
                CREATE TABLE IF NOT EXISTS holdings_polls (ts_ms INTEGER PRIMARY KEY);
                INSERT OR IGNORE INTO holdings_polls SELECT DISTINCT ts_ms FROM holdings_history;
                COMMIT;
                """
            )
        db.execute(
            """
            CREATE TABLE IF NOT EXISTS devices (
              id INTEGER PRIMARY KEY,
              name TEXT NOT NULL UNIQUE COLLATE NOCASE,
              token_sha256 TEXT NOT NULL UNIQUE,
              created_ms INTEGER NOT NULL,
              last_used_ms INTEGER
            )
            """
        )


MAX_HOLDING_META_JSON_CHARS = 2000
PERP_INSTRUMENTS = ("perp", "perp-cash")
# A holding's meta.group: a balance of its source included or left out as a
# whole (Hyperliquid's "perp" and "earn"). Connectors set it; see connectors/.
GROUP_ID = re.compile(r"^[a-z0-9][a-z0-9-]{0,31}$")


def _legacy_meta(source_id: str, kind: str, meta: dict) -> dict:
    """Holdings stored before 0.8 don't say their group, and the oldest
    Hyperliquid cash rows don't say their instrument either. Only
    Hyperliquid (source "hyperliquid-wallet") had groups, so this is the one
    place the server knows its name. Returns `meta` itself when it has
    nothing to add; delete this once no such rows are left."""
    if source_id != "hyperliquid-wallet" or meta.get("group"):
        return meta
    filled = dict(meta)
    instrument = filled.get("instrument")
    if kind == "cash" and instrument not in ("spot", "spot-cash", *PERP_INSTRUMENTS):
        filled["instrument"] = instrument = "perp-cash"
    if filled.get("account") == "earn":
        filled["group"] = "earn"
    elif instrument in PERP_INSTRUMENTS:
        filled["group"] = "perp"
    return filled if filled != meta else meta


def _clean_holding_meta(raw_meta: object) -> str | None:
    """Opaque per-holding extras (funding rate, leverage, ...) a collector
    wants to attach for its own UI to read back later -- this backend never
    interprets these fields itself, so it only has to keep them small and
    JSON-safe, not know what they mean. A flat dict of primitives only (no
    nested objects/arrays) keeps a careless collector from stashing
    something large or deeply nested in a column meant for a few numbers."""
    if not isinstance(raw_meta, dict) or not raw_meta:
        return None
    cleaned = {
        str(key)[:40]: value
        for key, value in raw_meta.items()
        if isinstance(value, (str, int, float, bool)) or value is None
    }
    if not cleaned:
        return None
    encoded = json.dumps(cleaned, separators=(",", ":"))
    return encoded[:MAX_HOLDING_META_JSON_CHARS] if len(encoded) <= MAX_HOLDING_META_JSON_CHARS else None


# A sample dated further ahead than this is refused: it would stay the
# newest, and its holdings the current ones (ingest), until then. The
# collector stamps samples with this computer's clock.
MAX_SAMPLE_AHEAD_MS = 5 * 60_000


def clean_frame(raw: dict) -> dict:
    now_ms = int(time.time() * 1000)
    ts_ms = int(raw.get("ts_ms") or now_ms)
    if ts_ms > now_ms + MAX_SAMPLE_AHEAD_MS:
        raise ValueError("the sample is dated in the future")
    currency = str(raw.get("currency") or "USD")[:8]
    sources = []
    for item in raw.get("sources") or []:
        source_id = str(item.get("id") or "").strip()[:64]
        if not source_id:
            raise ValueError("every source requires an id")
        holdings = []
        for holding in item.get("holdings") or []:
            value = float(holding.get("value") or 0)
            if value < 0:
                raise ValueError("holding values cannot be negative")
            symbol = str(holding.get("symbol") or "Asset").strip()[:32]
            kind = "cash" if holding.get("kind") == "cash" else "invested"
            holding_id = str(holding.get("id") or f"{symbol}:{kind}").strip()[:160]
            if not holding_id:
                raise ValueError("every holding requires an id")
            # quantity/price are optional for backward compatibility with
            # older callers that only ever sent a pre-multiplied value; when
            # absent we fall back to treating the whole value as "quantity"
            # priced at 1, which keeps totals correct even though it can't
            # be decomposed into a price-move vs a flow after the fact.
            has_quantity = "quantity" in holding and holding.get("quantity") is not None
            has_price = "price" in holding and holding.get("price") is not None
            quantity = max(0.0, float(holding.get("quantity"))) if has_quantity else value
            price = max(0.0, float(holding.get("price"))) if has_price else 1.0
            holdings.append({
                "id": holding_id, "symbol": symbol, "kind": kind, "value": value,
                "quantity": quantity, "price": price,
                "meta": _clean_holding_meta(holding.get("meta")),
            })
        source_value = max(0.0, float(item.get("value") or 0))
        perp_value = 0.0
        for holding in holdings:
            meta = json.loads(holding["meta"]) if holding["meta"] else {}
            filled = _legacy_meta(source_id, holding["kind"], meta)
            if "group" in filled and not GROUP_ID.match(str(filled["group"])):
                filled = {key: value for key, value in filled.items() if key != "group"}
            if filled is not meta:
                holding["meta"] = _clean_holding_meta(filled)
            if filled.get("instrument") in PERP_INSTRUMENTS:
                perp_value += holding["value"]
        if perp_value > source_value + max(0.01, source_value * 1e-8):
            raise ValueError("perp equity exceeds source total")
        sources.append(
            {
                "id": source_id,
                "label": str(item.get("label") or source_id)[:64],
                "value": source_value, "spot": source_value - perp_value, "perp": perp_value,
                "error_count": max(0, int(item.get("error_count") or 0)),
                "holdings": holdings,
            }
        )
    total = sum(source["value"] for source in sources)
    invested = sum(h["value"] for s in sources for h in s["holdings"] if h["kind"] == "invested")
    cash = sum(h["value"] for s in sources for h in s["holdings"] if h["kind"] == "cash")
    return {
        "ts_ms": ts_ms,
        "currency": currency,
        "sources": sources,
        "total": total,
        "spot": sum(s["spot"] for s in sources),
        "perp": sum(s["perp"] for s in sources),
        "invested": invested,
        "cash": cash,
        "error_count": sum(source["error_count"] for source in sources),
    }


def _is_persistable_holding(holding: dict) -> bool:
    """Keep valued holdings plus open perps whose cross-margin equity is zero."""
    if holding["value"] > 0:
        return True
    try:
        meta = json.loads(holding["meta"]) if holding.get("meta") else {}
    except (TypeError, ValueError):
        return False
    return meta.get("instrument") == "perp" and holding.get("quantity", 0) > 0


def ingest(db_path: str, raw: dict) -> dict:
    frame = clean_frame(raw)
    with connect(db_path) as db:
        db.execute("BEGIN IMMEDIATE")
        # Only the newest sample is the current state: an older one arriving
        # late (an import, the clock going back) is history only, or the
        # current holdings would be older than the total latest() reports.
        newest = db.execute("SELECT MAX(ts_ms) FROM portfolio_samples").fetchone()[0]
        is_current = newest is None or frame["ts_ms"] >= newest
        db.execute(
            "INSERT OR REPLACE INTO portfolio_samples (ts_ms,total,invested,cash,currency,error_count,spot,perp) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            (frame["ts_ms"], frame["total"], frame["invested"], frame["cash"],
             frame["currency"], frame["error_count"], frame["spot"], frame["perp"]),
        )
        # A sample replacing one at the same time replaces its holdings too.
        db.execute("DELETE FROM holdings_history WHERE ts_ms = ?", (frame["ts_ms"],))
        db.execute("INSERT OR IGNORE INTO holdings_polls (ts_ms) VALUES (?)", (frame["ts_ms"],))
        for source in frame["sources"]:
            db.executemany(
                "INSERT OR REPLACE INTO holdings_history (ts_ms,source_id,holding_id,symbol,kind,quantity,price,value,currency,meta) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                [(frame["ts_ms"], source["id"], h["id"], h["symbol"], h["kind"],
                 h["quantity"], h["price"], h["value"], frame["currency"], h["meta"])
                 for h in source["holdings"] if _is_persistable_holding(h)],
            )
        if not is_current:
            return frame
        live_ids = [source["id"] for source in frame["sources"]]
        if live_ids:
            placeholders = ",".join("?" for _ in live_ids)
            db.execute(f"DELETE FROM source_status WHERE source_id NOT IN ({placeholders})", live_ids)
            db.execute(f"DELETE FROM current_holdings WHERE source_id NOT IN ({placeholders})", live_ids)
        else:
            db.execute("DELETE FROM source_status")
            db.execute("DELETE FROM current_holdings")
        for source in frame["sources"]:
            db.execute(
                "INSERT OR REPLACE INTO source_status (source_id,label,value,currency,updated_at_ms,error_count,spot,perp) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                (source["id"], source["label"], source["value"], frame["currency"],
                 frame["ts_ms"], source["error_count"], source["spot"], source["perp"]),
            )
            db.execute("DELETE FROM current_holdings WHERE source_id = ?", (source["id"],))
            db.executemany(
                "INSERT INTO current_holdings (source_id,holding_id,symbol,kind,value,currency,updated_at_ms,quantity,price,meta) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                [(source["id"], h["id"], h["symbol"], h["kind"], h["value"], frame["currency"],
                  frame["ts_ms"], h["quantity"], h["price"], h["meta"])
                 for h in source["holdings"] if _is_persistable_holding(h)],
            )
    return frame


def _ratios(total: float, invested: float, cash: float) -> dict:
    if total <= 0:
        return {"investedRatio": 0.0, "cashRatio": 0.0}
    return {"investedRatio": invested / total, "cashRatio": cash / total}


def _holding_row(row: sqlite3.Row) -> dict:
    item = dict(row)
    raw_meta = item.get("meta")
    try:
        item["meta"] = json.loads(raw_meta) if raw_meta else None
    except (TypeError, ValueError):
        item["meta"] = None
    filled = _legacy_meta(item.get("source_id") or "", item.get("kind") or "", item["meta"] or {})
    if filled:
        item["meta"] = filled
    return item


def latest(db_path: str) -> dict:
    with connect(db_path) as db:
        # One read transaction: a collection committing between the three
        # reads would otherwise mix two snapshots (a total with the next
        # poll's holdings).
        db.execute("BEGIN")
        sample = db.execute("SELECT * FROM portfolio_samples ORDER BY ts_ms DESC LIMIT 1").fetchone()
        sources = [dict(row) for row in db.execute("SELECT * FROM source_status ORDER BY value DESC")]
        holdings = [_holding_row(row) for row in db.execute("SELECT * FROM current_holdings ORDER BY value DESC")]
    if sample is None:
        return {"timestamp": None, "total": 0, "invested": 0, "cash": 0,
                "investedRatio": 0.0, "cashRatio": 0.0,
                "currency": "USD", "errorCount": 0, "sources": [], "holdings": []}
    return {
        "timestamp": sample["ts_ms"], "total": sample["total"],
        "spot": sample["spot"], "perp": sample["perp"],
        "invested": sample["invested"], "cash": sample["cash"],
        **_ratios(sample["total"], sample["invested"], sample["cash"]),
        "currency": sample["currency"], "errorCount": sample["error_count"],
        "sources": sources, "holdings": holdings,
    }


def history(db_path: str, start_ms: int, end_ms: int, resolution: str,
            excluded: set[tuple[str, str]] | None = None,
            excluded_sources: set[str] | None = None,
            excluded_groups: set[tuple[str, str]] | None = None) -> list[dict]:
    bucket = RESOLUTIONS_MS.get(resolution, 0)
    with connect(db_path) as db:
        if bucket:
            rows = db.execute(
                """
                WITH newest AS (
                  SELECT (ts_ms / ?) * ? AS bucket_ms, MAX(ts_ms) AS ts_ms
                  FROM portfolio_samples WHERE ts_ms BETWEEN ? AND ? GROUP BY bucket_ms
                )
                SELECT p.* FROM newest n JOIN portfolio_samples p ON p.ts_ms = n.ts_ms
                ORDER BY p.ts_ms LIMIT ?
                """,
                (bucket, bucket, start_ms, end_ms, MAX_HISTORY_ROWS),
            ).fetchall()
        else:
            rows = db.execute(
                "SELECT * FROM portfolio_samples WHERE ts_ms BETWEEN ? AND ? ORDER BY ts_ms LIMIT ?",
                (start_ms, end_ms, MAX_HISTORY_ROWS),
            ).fetchall()
        adjustments: dict[int, dict[str, float]] = {}
        if (excluded or excluded_sources or excluded_groups) and rows:
            conditions = ["(source_id = ? AND holding_id = ?)" for _ in (excluded or set())]
            params: list[object] = []
            for source_id, holding_id in excluded or set():
                params.extend((source_id, holding_id))
            if excluded_sources:
                conditions.append(f"source_id IN ({','.join('?' for _ in excluded_sources)})")
                params.extend(sorted(excluded_sources))
            group_sources = sorted({source_id for source_id, _ in (excluded_groups or set())})
            if group_sources:
                conditions.append(f"source_id IN ({','.join('?' for _ in group_sources)})")
                params.extend(group_sources)
            # Only the holdings behind the points returned (each bucket's
            # newest sample), not every poll in the range: a 5-minute tier
            # over four weeks reads a fifth of the rows. By primary key.
            selected = [row["ts_ms"] for row in rows]
            # A holding's meta is the same poll after poll: read once.
            meta_seen: dict[tuple, tuple] = {}

            def items():
                for start in range(0, len(selected), SAMPLES_PER_QUERY):
                    chunk = selected[start:start + SAMPLES_PER_QUERY]
                    yield from db.execute(
                        f"SELECT ts_ms,source_id,holding_id,kind,value,meta FROM holdings_history "
                        f"WHERE ts_ms IN ({','.join('?' for _ in chunk)}) AND ({' OR '.join(conditions)})",
                        [*chunk, *params],
                    )

            for item in items():
                key = (item["source_id"], item["kind"], item["meta"])
                if key not in meta_seen:
                    try:
                        meta = json.loads(item["meta"]) if item["meta"] else {}
                    except (TypeError, ValueError):
                        meta = {}
                    meta = _legacy_meta(item["source_id"], item["kind"], meta)
                    meta_seen[key] = (meta.get("instrument"), meta.get("group") or None)
                instrument, group = meta_seen[key]
                source_match = item["source_id"] in (excluded_sources or set())
                group_match = (item["source_id"], group) in (excluded_groups or set())
                holding_match = (item["source_id"], item["holding_id"]) in (excluded or set())
                # A grouped holding (a position, and the collateral backing
                # it) is left out only with its group or its whole source;
                # an exclusion of it on its own is ignored.
                if not source_match and not group_match and (not holding_match or group is not None):
                    continue
                adjustment = adjustments.setdefault(item["ts_ms"], {
                    "total": 0.0, "spot": 0.0, "perp": 0.0,
                    "invested": 0.0, "cash": 0.0,
                })
                value = max(0.0, float(item["value"] or 0))
                adjustment["total"] += value
                adjustment["cash" if item["kind"] == "cash" else "invested"] += value
                is_perp = instrument in PERP_INSTRUMENTS
                adjustment["perp" if is_perp else "spot"] += value

    points = []
    for row in rows:
        adjustment = adjustments.get(row["ts_ms"], {})
        total = max(0.0, row["total"] - adjustment.get("total", 0.0))
        invested = max(0.0, row["invested"] - adjustment.get("invested", 0.0))
        cash = max(0.0, row["cash"] - adjustment.get("cash", 0.0))
        spot = None if row["spot"] is None else max(0.0, row["spot"] - adjustment.get("spot", 0.0))
        perp = None if row["perp"] is None else max(0.0, row["perp"] - adjustment.get("perp", 0.0))
        points.append({
            "t": row["ts_ms"], "v": total, "spot": spot, "perp": perp,
            "invested": invested, "cash": cash, **_ratios(total, invested, cash),
            "currency": row["currency"], "errorCount": row["error_count"],
        })
    return points


def holdings_history(db_path: str, start_ms: int, end_ms: int,
                      source_id: str | None = None, symbol: str | None = None) -> list[dict]:
    """Point-in-time holdings: what was held, in what quantity, at what price."""
    return holdings_history_page(db_path, start_ms, end_ms, source_id, symbol)[0]


def holdings_history_page(db_path: str, start_ms: int, end_ms: int,
                          source_id: str | None = None, symbol: str | None = None,
                          newest_first: bool = False) -> tuple[list[dict], list[int], bool]:
    """holdings_history, at most MAX_HOLDINGS_HISTORY_ROWS rows from the
    oldest poll on (or the newest, newest_first); the polls recorded
    (holdings_polls) that the page covers, holdings or not, so a poll where
    nothing was held shows as one; and whether more were left out. Only whole polls: one the
    limit cut is left for the next page, so the last poll sent is never
    taken for a smaller holding (and a poll bigger than the limit on its
    own isn't sent at all)."""
    clauses = ["ts_ms BETWEEN ? AND ?"]
    params: list[object] = [start_ms, end_ms]
    if source_id:
        clauses.append("source_id = ?")
        params.append(source_id)
    if symbol:
        clauses.append("symbol = ?")
        params.append(symbol)
    params.append(MAX_HOLDINGS_HISTORY_ROWS + 1)
    order = "DESC" if newest_first else "ASC"
    with connect(db_path) as db:
        db.execute("BEGIN")  # the rows and the polls from one state
        rows = db.execute(
            f"SELECT * FROM holdings_history WHERE {' AND '.join(clauses)} "
            f"ORDER BY ts_ms {order}, source_id, symbol LIMIT ?",
            params,
        ).fetchall()
        polls = [row[0] for row in db.execute(
            f"SELECT ts_ms FROM holdings_polls WHERE ts_ms BETWEEN ? AND ? ORDER BY ts_ms {order} LIMIT ?",
            (start_ms, end_ms, MAX_HOLDINGS_HISTORY_ROWS + 1),
        )]
    # Where the page ends (the first poll not sent whole), if it does.
    edges = []
    if len(rows) > MAX_HOLDINGS_HISTORY_ROWS:
        edges.append(rows[MAX_HOLDINGS_HISTORY_ROWS - 1]["ts_ms"])
    if len(polls) > MAX_HOLDINGS_HISTORY_ROWS:
        edges.append(polls[MAX_HOLDINGS_HISTORY_ROWS])
    if not edges:
        return [_holding_row(row) for row in rows], polls, False
    edge = max(edges) if newest_first else min(edges)
    inside = (lambda ts: ts > edge) if newest_first else (lambda ts: ts < edge)
    return ([_holding_row(row) for row in rows if inside(row["ts_ms"])],
            [ts for ts in polls if inside(ts)], True)


def db_stats(db_path: str) -> dict:
    with connect(db_path) as db:
        samples = db.execute("SELECT COUNT(*) FROM portfolio_samples").fetchone()[0]
        holdings = db.execute("SELECT COUNT(*) FROM current_holdings").fetchone()[0]
        holdings_history_rows = db.execute("SELECT COUNT(*) FROM holdings_history").fetchone()[0]
    files = [Path(db_path), Path(db_path + "-wal"), Path(db_path + "-shm")]
    return {"samples": samples, "holdings": holdings, "holdingsHistoryRows": holdings_history_rows,
            "databaseBytes": sum(path.stat().st_size for path in files if path.exists())}


def info(db_path: str, device: str | None = None) -> dict:
    """What Finance's "Test connection" shows: which server, how many sources,
    how fresh, and which paired device is asking."""
    with connect(db_path) as db:
        sources = db.execute("SELECT COUNT(*) FROM source_status").fetchone()[0]
        last = db.execute("SELECT MAX(ts_ms) FROM portfolio_samples").fetchone()[0]
    retention = retention_settings()
    return {"name": "atmos-portfolio", "version": VERSION, "apiVersion": API_VERSION,
            "device": device, "sources": sources, "lastUpdate": last,
            "retention": {"holdingsRawDays": retention["rawDays"], "holdingsHourlyDays": retention["hourlyDays"]}
            if retention["enabled"] else None}


def retention_settings(env: dict | None = None) -> dict:
    """{"enabled", "rawDays", "hourlyDays"} from the environment (the service's env file)."""
    env = os.environ if env is None else env
    enabled = str(env.get("ATMOS_PORTFOLIO_RETENTION", "on")).strip().lower() not in ("off", "0", "false", "no")

    def days(key: str, default: int) -> int:
        try:
            value = int(str(env.get(key, default)).strip())
        except ValueError:
            return default
        return max(1, value)

    raw_days = days("ATMOS_PORTFOLIO_RAW_DAYS", DEFAULT_RAW_DAYS)
    hourly_days = max(raw_days, days("ATMOS_PORTFOLIO_HOURLY_DAYS", DEFAULT_HOURLY_DAYS))
    return {"enabled": enabled, "rawDays": raw_days, "hourlyDays": hourly_days}


def _thin(db: sqlite3.Connection, start_ms: int, end_ms: int, bucket_ms: int) -> int:
    """In [start, end), keep holdings only at the last sample of each bucket.

    The kept timestamps are the ones history() selects for that resolution
    (the newest portfolio_samples row per bucket), so scope filters still
    find the holdings behind every point Finance draws. The polls recorded
    (holdings_polls) are thinned the same way."""
    kept = "SELECT MAX(ts_ms) FROM portfolio_samples WHERE ts_ms >= ? AND ts_ms < ? GROUP BY ts_ms / ?"
    params = (start_ms, end_ms, start_ms, end_ms, bucket_ms)
    cursor = db.execute(f"DELETE FROM holdings_history WHERE ts_ms >= ? AND ts_ms < ? AND ts_ms NOT IN ({kept})", params)
    db.execute(f"DELETE FROM holdings_polls WHERE ts_ms >= ? AND ts_ms < ? AND ts_ms NOT IN ({kept})", params)
    return cursor.rowcount


def prune(db_path: str, now_ms: int | None = None, settings: dict | None = None,
          vacuum: bool = False) -> dict:
    """Thin old holdings_history. A day at a time, so the collector never
    waits long for the write lock even on a first run over a year of polls."""
    settings = settings or retention_settings()
    now_ms = int(time.time() * 1000) if now_ms is None else now_ms
    result = {"deleted": 0, **settings}
    if not settings["enabled"]:
        return result
    raw_cutoff = ((now_ms - settings["rawDays"] * DAY_MS) // DAY_MS) * DAY_MS
    hourly_cutoff = ((now_ms - settings["hourlyDays"] * DAY_MS) // DAY_MS) * DAY_MS
    with connect(db_path) as db:
        oldest = db.execute("SELECT MIN(ts) FROM (SELECT MIN(ts_ms) AS ts FROM holdings_history "
                            "UNION ALL SELECT MIN(ts_ms) FROM holdings_polls)").fetchone()[0]
    if oldest is None or oldest >= raw_cutoff:
        return result
    day = (oldest // DAY_MS) * DAY_MS
    while day < raw_cutoff:
        bucket = DAY_MS if day < hourly_cutoff else HOUR_MS
        with connect(db_path) as db:
            result["deleted"] += _thin(db, day, day + DAY_MS, bucket)
        day += DAY_MS
    with connect(db_path) as db:
        db.execute("PRAGMA wal_checkpoint(TRUNCATE)")
    if vacuum:
        # Returns freed pages to the filesystem. Needs free disk about the
        # size of the database, and blocks writers while it runs.
        db = sqlite3.connect(db_path, timeout=60)
        try:
            db.execute("VACUUM")
        finally:
            db.close()
    return result


def backup(db_path: str, out_path: str) -> dict:
    """A consistent copy of the live database (SQLite's online backup), safe
    while the API and collector are writing."""
    out = Path(out_path)
    if out.exists():
        raise ValueError(f"{out} already exists")
    out.parent.mkdir(parents=True, exist_ok=True)
    source = sqlite3.connect(db_path, timeout=30)
    target = sqlite3.connect(str(out))
    try:
        source.backup(target)
    finally:
        target.close()
        source.close()
    return {"backup": str(out), "bytes": out.stat().st_size}


def _token_sha256(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def add_device(db_path: str, name: str, now_ms: int | None = None) -> tuple[dict, str]:
    """A new paired device and its token. The token is returned once and
    only its hash is stored: lose the pairing code and you add the device again."""
    name = " ".join(str(name or "").split())
    if not DEVICE_NAME.match(name):
        raise ValueError("a device name is 1 to 48 letters, digits, spaces, dots, dashes or underscores")
    if name.lower() == SHARED_TOKEN_DEVICE:
        raise ValueError(f"{name!r} is reserved")
    token = secrets.token_urlsafe(48)
    now_ms = int(time.time() * 1000) if now_ms is None else now_ms
    try:
        with connect(db_path) as db:
            cursor = db.execute("INSERT INTO devices (name, token_sha256, created_ms) VALUES (?, ?, ?)",
                                (name, _token_sha256(token), now_ms))
            device_id = cursor.lastrowid
    except sqlite3.IntegrityError:
        raise ValueError(f"a device called {name!r} is already paired; revoke it first or choose another name") from None
    return {"id": device_id, "name": name, "created": now_ms, "lastUsed": None}, token


def list_devices(db_path: str) -> list[dict]:
    with connect(db_path) as db:
        rows = db.execute("SELECT id, name, created_ms, last_used_ms FROM devices ORDER BY created_ms, id").fetchall()
    return [{"id": row["id"], "name": row["name"], "created": row["created_ms"], "lastUsed": row["last_used_ms"]}
            for row in rows]


def revoke_device(db_path: str, name: str) -> bool:
    """Forget a device's token. Its next request is refused; nothing else changes."""
    with connect(db_path) as db:
        return db.execute("DELETE FROM devices WHERE name = ?", (" ".join(str(name or "").split()),)).rowcount > 0


def device_for_token(db_path: str, token: str, now_ms: int | None = None) -> str | None:
    """The name of the device this token belongs to, or None."""
    if not token or len(token) > MAX_TOKEN_CHARS:
        return None
    now_ms = int(time.time() * 1000) if now_ms is None else now_ms
    with connect(db_path) as db:
        row = db.execute("SELECT id, name, last_used_ms FROM devices WHERE token_sha256 = ?",
                         (_token_sha256(token),)).fetchone()
        if row is None:
            return None
        if row["last_used_ms"] is None or now_ms - row["last_used_ms"] >= LAST_USED_EVERY_MS:
            try:
                db.execute("PRAGMA busy_timeout=200")  # never hold a request up for it
                db.execute("UPDATE devices SET last_used_ms = ? WHERE id = ?", (now_ms, row["id"]))
            except sqlite3.OperationalError:
                pass  # busy: last used is a convenience, never a reason to refuse
        return row["name"]


def _is_private_http_host(hostname: str) -> bool:
    if hostname in ("localhost",):
        return True
    try:
        address = ipaddress.ip_address(hostname.strip("[]"))
    except ValueError:
        return False
    return address.is_loopback or address in ipaddress.ip_network("100.64.0.0/10")


def public_url(url: str) -> str:
    """The address Finance should use, under the same rules Finance applies:
    https:// anywhere, http:// only on Tailscale or the same computer, and the
    server's root (no path, query or credentials)."""
    parsed = urlparse(url.strip())
    if parsed.scheme not in ("http", "https") or not parsed.hostname:
        raise ValueError("the address must start with https:// or http://")
    if parsed.scheme == "http" and not _is_private_http_host(parsed.hostname):
        raise ValueError("use https://, or http:// only on a Tailscale address or this computer")
    if parsed.username or parsed.password or parsed.path not in ("", "/") or parsed.query or parsed.fragment:
        raise ValueError("use the server's address without a path")
    return f"{parsed.scheme}://{parsed.netloc}"


def pairing_code(url: str, token: str) -> str:
    """The code Finance's Portfolio Connections widget takes: atmos-finance: +
    base64url JSON {url, token}. It contains a device's token: treat it like one."""
    if len(token) < 32:
        raise ValueError("the server token is missing or too short")
    body = json.dumps({"url": public_url(url), "token": token}, separators=(",", ":")).encode()
    return PAIRING_PREFIX + base64.urlsafe_b64encode(body).decode().rstrip("=")


def read_env_file(path: str) -> dict[str, str]:
    values: dict[str, str] = {}
    for line in Path(path).read_text(encoding="utf-8").splitlines():
        if line and not line.lstrip().startswith("#") and "=" in line:
            key, value = line.split("=", 1)
            values[key.strip()] = value.strip()
    return values


def default_url(settings: dict[str, str]) -> str:
    explicit = settings.get("ATMOS_PORTFOLIO_PUBLIC_URL", "").strip()
    if explicit:
        return explicit
    host = settings.get("ATMOS_PORTFOLIO_HOST", "127.0.0.1")
    port = settings.get("ATMOS_PORTFOLIO_PORT", "8787")
    if host in ("0.0.0.0", "::", ""):
        raise ValueError("the server listens on every address; set ATMOS_PORTFOLIO_PUBLIC_URL or pass --url")
    return f"http://{host}:{port}"


def _millis(query: dict, key: str, default: int) -> int:
    raw = query.get(key, [None])[0]
    if raw in (None, ""):
        return default
    try:
        return int(raw)
    except ValueError:
        raise ValueError(f"{key} must be a whole number of milliseconds") from None


def integrity_check(db_path: str) -> str:
    with connect(db_path) as db:
        return str(db.execute("PRAGMA integrity_check").fetchone()[0])


class ApiHandler(BaseHTTPRequestHandler):
    server_version = "AtmosPortfolio/" + VERSION

    def log_message(self, fmt: str, *args: object) -> None:
        # Never log authorization headers or query values.
        sys.stderr.write("%s %s\n" % (self.address_string(), fmt % args))

    def log_request(self, code: object = "-", size: object = "-") -> None:
        # send_json() logs each answer itself, with its time and size and
        # without the query (it names holdings).
        pass

    def send_json(self, status: HTTPStatus, payload: object) -> None:
        body = json.dumps(payload, separators=(",", ":")).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        started = getattr(self, "_started", None)
        took = f"{(time.monotonic() - started) * 1000:.0f} ms" if started is not None else "-"
        path = urlparse(self.path).path
        try:
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError):
            # Finance stopped waiting (it gives up after 20 s): say so, no traceback.
            self.log_message("%s %d %s %d bytes, but the client had gone", path, int(status), took, len(body))
            self.close_connection = True
            return
        self.log_message("%s %d %s %d bytes", path, int(status), took, len(body))

    def authorized(self) -> str | None:
        """The paired device making this request, or None. The shared token
        (ATMOS_PORTFOLIO_TOKEN, from before 0.9) is still accepted while it's set."""
        supplied = self.headers.get("Authorization", "")
        if not supplied.startswith("Bearer "):
            return None
        token = supplied[len("Bearer "):]
        shared = getattr(self.server, "api_token", "") or ""
        if shared and hmac.compare_digest(token.encode("utf-8", "replace"), shared.encode("utf-8")):
            return SHARED_TOKEN_DEVICE
        return device_for_token(self.server.db_path, token)

    def do_GET(self) -> None:
        self._started = time.monotonic()
        parsed = urlparse(self.path)
        if parsed.path == "/health":
            # Unauthenticated, so it says only that the service is up.
            self.send_json(HTTPStatus.OK, {"status": "ok", "version": VERSION})
            return
        try:
            self.device = self.authorized()
        except sqlite3.Error:
            self.send_json(HTTPStatus.SERVICE_UNAVAILABLE, {"error": "busy, try again"})
            return
        if not self.device:
            self.send_json(HTTPStatus.UNAUTHORIZED, {"error": "unauthorized"})
            return
        try:
            if parsed.path in HEAVY_ROUTES:
                with _heavy:
                    self.route(parsed)
            else:
                self.route(parsed)
        except ValueError as error:
            self.send_json(HTTPStatus.BAD_REQUEST, {"error": str(error)})

    def route(self, parsed) -> None:
        if parsed.path == "/v1/info":
            self.send_json(HTTPStatus.OK, info(self.server.db_path, self.device))
            return
        if parsed.path == "/v1/portfolio":
            self.send_json(HTTPStatus.OK, latest(self.server.db_path))
            return
        if parsed.path == "/v1/history":
            query = parse_qs(parsed.query)
            now_ms = int(time.time() * 1000)
            start_ms = _millis(query, "from", 0)
            end_ms = _millis(query, "to", now_ms)
            resolution = query.get("resolution", ["raw"])[0]
            if resolution not in RESOLUTIONS_MS:
                self.send_json(HTTPStatus.BAD_REQUEST, {"error": "invalid resolution"})
                return
            excluded: set[tuple[str, str]] = set()
            for key in query.get("exclude", [])[:200]:
                source_id, separator, holding_id = str(key).partition("|")
                if separator and source_id and holding_id:
                    excluded.add((source_id[:64], holding_id[:160]))
            excluded_sources = {
                str(source_id)[:64] for source_id in query.get("excludeSource", [])[:100]
                if source_id
            }
            excluded_groups: set[tuple[str, str]] = set()
            for key in query.get("excludeGroup", [])[:100]:
                source_id, separator, group = str(key).partition("|")
                if separator and source_id and GROUP_ID.match(group):
                    excluded_groups.add((source_id[:64], group))
            points = history(
                self.server.db_path, start_ms, end_ms, resolution,
                excluded, excluded_sources, excluded_groups,
            )
            self.send_json(HTTPStatus.OK, {
                "resolution": resolution,
                "points": points,
                # The newest points past the limit are missing: ask again from the last `t`.
                "truncated": len(points) >= MAX_HISTORY_ROWS,
            })
            return
        if parsed.path == "/v1/holdings-history":
            query = parse_qs(parsed.query)
            now_ms = int(time.time() * 1000)
            start_ms = _millis(query, "from", 0)
            end_ms = _millis(query, "to", now_ms)
            source_id = (query.get("source", [None])[0]) or None
            symbol = (query.get("symbol", [None])[0]) or None
            # order=desc: the newest polls first (a snapshot before a time).
            newest_first = query.get("order", ["asc"])[0] == "desc"
            points, polls, truncated = holdings_history_page(self.server.db_path, start_ms, end_ms, source_id, symbol, newest_first)
            self.send_json(HTTPStatus.OK, {
                "points": points,
                # Every poll the page covers: one with no points held nothing.
                "polls": polls,
                # Only whole polls; more were left out: ask again past the last
                # poll listed (polls; points can end before it, in empty polls).
                "truncated": truncated,
                "order": "desc" if newest_first else "asc",
            })
            return
        self.send_json(HTTPStatus.NOT_FOUND, {"error": "not found"})


def serve(db_path: str) -> None:
    migrate(db_path)
    host = os.environ.get("ATMOS_PORTFOLIO_HOST", "127.0.0.1")
    port = int(os.environ.get("ATMOS_PORTFOLIO_PORT", "8787"))
    # The shared token from before 0.9 is optional: devices paired with
    # `server.py device add` each have their own.
    token = os.environ.get("ATMOS_PORTFOLIO_TOKEN", "").strip()
    if token and len(token) < 32:
        raise SystemExit("ATMOS_PORTFOLIO_TOKEN must contain at least 32 characters (or remove it)")
    server = ThreadingHTTPServer((host, port), ApiHandler)
    server.db_path = db_path
    server.api_token = token
    server.serve_forever()


def _run_as_database_owner(db_path: str) -> None:
    """Run as root (sudo), become the user who owns the database first, so
    SQLite's -wal and -shm files are never left owned by root, where the
    service couldn't write them."""
    if not hasattr(os, "geteuid") or os.geteuid() != 0:
        return
    path = Path(db_path)
    owner = (path if path.exists() else path.parent).stat()
    if owner.st_uid == 0:
        return
    os.setgroups([])
    os.setgid(owner.st_gid)
    os.setuid(owner.st_uid)


def _when(ms: int | None) -> str:
    return time.strftime("%Y-%m-%d %H:%M UTC", time.gmtime(ms / 1000)) if ms else "never"


def _settings(env_file: str) -> dict[str, str]:
    settings = dict(os.environ)
    if Path(env_file).exists():
        settings.update(read_env_file(env_file))
    return settings


def _pair(db_path: str, name: str, url: str | None, settings: dict[str, str]) -> None:
    address = public_url(url or default_url(settings))  # checked before a device is added
    device, token = add_device(db_path, name)
    print(f"Pairing code for {device['name']} (Finance: Portfolio Connections > Pairing code).\n"
          "It works until you revoke the device; paste it only into Atmos.", file=sys.stderr)
    print(pairing_code(address, token))


def device_command(db_path: str, words: list[str], url: str | None, settings: dict[str, str]) -> None:
    action, name = (words[0] if words else ""), " ".join(words[1:])
    if action == "add" and name:
        _pair(db_path, name, url, settings)
    elif action == "list" and not name:
        devices = list_devices(db_path)
        for device in devices:
            print(f"{device['name']:<24} paired {_when(device['created'])}, last used {_when(device['lastUsed'])}")
        if not devices:
            print("No devices paired. Add one with: server.py device add NAME")
        if settings.get("ATMOS_PORTFOLIO_TOKEN", "").strip():
            print(f"{'(shared token)':<24} ATMOS_PORTFOLIO_TOKEN is set: any device holding it can read. "
                  "Pair each device on its own, then remove it.")
    elif action == "revoke" and name:
        if not revoke_device(db_path, name):
            raise SystemExit(f"device: no device called {name!r} (see: server.py device list)")
        print(f"Revoked {name}. Its next request is refused.")
    else:
        raise SystemExit("device: use `device add NAME`, `device list` or `device revoke NAME`")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("command", choices=("init", "serve", "ingest", "status", "integrity", "pairing", "device", "prune", "backup"))
    parser.add_argument("words", nargs="*", help="device: add NAME, list, or revoke NAME")
    parser.add_argument("--db", default=None, help="default: ATMOS_PORTFOLIO_DB, or " + DEFAULT_DB)
    parser.add_argument("--file", help="JSON frame; omit to read stdin")
    parser.add_argument("--name", help="pairing: the new device's name (default: device N)")
    parser.add_argument("--url", help="pairing, device add: the address Finance should use (default: ATMOS_PORTFOLIO_PUBLIC_URL, or the bind address)")
    parser.add_argument("--env-file", default="/etc/atmos-portfolio.env", help="where the address (and any shared token) are configured")
    parser.add_argument("--vacuum", action="store_true", help="prune: also give freed space back to the filesystem")
    parser.add_argument("--out", help="backup: the file to write (must not exist)")
    args = parser.parse_args()
    db_given = args.db is not None
    if not db_given:
        args.db = os.environ.get("ATMOS_PORTFOLIO_DB", DEFAULT_DB)
    if args.words and args.command != "device":
        parser.error(f"{args.command} takes no further words")
    if args.command in ("pairing", "device"):
        settings = _settings(args.env_file)
        db_path = args.db if db_given else settings.get("ATMOS_PORTFOLIO_DB") or args.db
        _run_as_database_owner(db_path)
        migrate(db_path)
        try:
            if args.command == "pairing":
                # Each pairing code is a new device with a token of its own.
                taken = {device["name"].lower() for device in list_devices(db_path)}
                name = args.name or next(f"device {n}" for n in range(1, len(taken) + 2) if f"device {n}" not in taken)
                _pair(db_path, name, args.url, settings)
            else:
                device_command(db_path, args.words, args.url, settings)
        except ValueError as error:
            raise SystemExit(f"{args.command}: {error}")
        return
    migrate(args.db)
    if args.command == "serve":
        serve(args.db)
    elif args.command == "ingest":
        raw = json.loads(Path(args.file).read_text() if args.file else sys.stdin.read())
        frame = ingest(args.db, raw)
        print(json.dumps({"timestamp": frame["ts_ms"], "sources": len(frame["sources"])}))
    elif args.command == "prune":
        print(json.dumps(prune(args.db, settings=retention_settings(_settings(args.env_file)), vacuum=args.vacuum)))
    elif args.command == "backup":
        if not args.out:
            raise SystemExit("backup: pass --out FILE")
        try:
            print(json.dumps(backup(args.db, args.out)))
        except ValueError as error:
            raise SystemExit(f"backup: {error}")
    elif args.command == "status":
        print(json.dumps(db_stats(args.db)))
    elif args.command == "integrity":
        result = integrity_check(args.db)
        print(result)
        if result != "ok":
            raise SystemExit(1)


if __name__ == "__main__":
    main()
