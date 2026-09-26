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
import sqlite3
import sys
import time
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

VERSION = "0.7.0"
API_VERSION = 1
PAIRING_PREFIX = "atmos-finance:"
DEFAULT_DB = "/var/lib/atmos-portfolio/portfolio.sqlite3"
MAX_HISTORY_ROWS = 10_000
MAX_HOLDINGS_HISTORY_ROWS = 50_000
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
        if "holding_id" not in _column_names(db, "current_holdings"):
            db.executescript(
                """
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
                """
            )
        db.execute("CREATE INDEX IF NOT EXISTS holdings_history_lookup ON holdings_history(source_id, symbol, ts_ms)")


MAX_HOLDING_META_JSON_CHARS = 2000


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


def clean_frame(raw: dict) -> dict:
    ts_ms = int(raw.get("ts_ms") or int(time.time() * 1000))
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
            instrument = meta.get("instrument")
            if instrument in ("perp", "perp-cash"):
                perp_value += holding["value"]
            elif source_id == "hyperliquid-wallet" and holding["kind"] == "cash" and instrument not in ("spot", "spot-cash"):
                # Compatibility with pre-upgrade idle collateral and stale snapshots.
                perp_value += holding["value"]
                meta["instrument"] = "perp-cash"
                holding["meta"] = _clean_holding_meta(meta)
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
        db.execute(
            "INSERT OR REPLACE INTO portfolio_samples (ts_ms,total,invested,cash,currency,error_count,spot,perp) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            (frame["ts_ms"], frame["total"], frame["invested"], frame["cash"],
             frame["currency"], frame["error_count"], frame["spot"], frame["perp"]),
        )
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
            db.executemany(
                "INSERT OR REPLACE INTO holdings_history (ts_ms,source_id,holding_id,symbol,kind,quantity,price,value,currency,meta) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                [(frame["ts_ms"], source["id"], h["id"], h["symbol"], h["kind"],
                 h["quantity"], h["price"], h["value"], frame["currency"], h["meta"])
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
    return item


def latest(db_path: str) -> dict:
    with connect(db_path) as db:
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
            params: list[object] = [start_ms, end_ms]
            for source_id, holding_id in excluded or set():
                params.extend((source_id, holding_id))
            if excluded_sources:
                conditions.append(f"source_id IN ({','.join('?' for _ in excluded_sources)})")
                params.extend(sorted(excluded_sources))
            group_sources = sorted({source_id for source_id, _ in (excluded_groups or set())})
            if group_sources:
                conditions.append(f"source_id IN ({','.join('?' for _ in group_sources)})")
                params.extend(group_sources)
            selected = {row["ts_ms"] for row in rows}
            for item in db.execute(
                f"SELECT ts_ms,source_id,holding_id,kind,value,meta FROM holdings_history "
                f"WHERE ts_ms BETWEEN ? AND ? AND ({' OR '.join(conditions)})",
                params,
            ):
                if item["ts_ms"] not in selected:
                    continue
                try:
                    meta = json.loads(item["meta"]) if item["meta"] else {}
                except (TypeError, ValueError):
                    meta = {}
                instrument = meta.get("instrument")
                group = None
                if item["source_id"] == "hyperliquid-wallet":
                    if meta.get("account") == "earn":
                        group = "earn"
                    elif instrument in ("perp", "perp-cash"):
                        group = "perp"
                source_match = item["source_id"] in (excluded_sources or set())
                group_match = (item["source_id"], group) in (excluded_groups or set())
                holding_match = (item["source_id"], item["holding_id"]) in (excluded or set())
                # Positions are exposure backed by their parent's shared
                # balance. A legacy per-position key is ignored; excluding
                # the Perp group or whole source removes the stable balance.
                if not source_match and not group_match and (not holding_match or group is not None):
                    continue
                adjustment = adjustments.setdefault(item["ts_ms"], {
                    "total": 0.0, "spot": 0.0, "perp": 0.0,
                    "invested": 0.0, "cash": 0.0,
                })
                value = max(0.0, float(item["value"] or 0))
                adjustment["total"] += value
                adjustment["cash" if item["kind"] == "cash" else "invested"] += value
                is_perp = instrument in ("perp", "perp-cash") or (
                    item["source_id"] == "hyperliquid-wallet"
                    and item["kind"] == "cash"
                    and instrument not in ("spot", "spot-cash")
                )
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
    clauses = ["ts_ms BETWEEN ? AND ?"]
    params: list[object] = [start_ms, end_ms]
    if source_id:
        clauses.append("source_id = ?")
        params.append(source_id)
    if symbol:
        clauses.append("symbol = ?")
        params.append(symbol)
    params.append(MAX_HOLDINGS_HISTORY_ROWS)
    with connect(db_path) as db:
        rows = db.execute(
            f"SELECT * FROM holdings_history WHERE {' AND '.join(clauses)} "
            "ORDER BY ts_ms, source_id, symbol LIMIT ?",
            params,
        ).fetchall()
    return [_holding_row(row) for row in rows]


def db_stats(db_path: str) -> dict:
    with connect(db_path) as db:
        samples = db.execute("SELECT COUNT(*) FROM portfolio_samples").fetchone()[0]
        holdings = db.execute("SELECT COUNT(*) FROM current_holdings").fetchone()[0]
        holdings_history_rows = db.execute("SELECT COUNT(*) FROM holdings_history").fetchone()[0]
    files = [Path(db_path), Path(db_path + "-wal"), Path(db_path + "-shm")]
    return {"samples": samples, "holdings": holdings, "holdingsHistoryRows": holdings_history_rows,
            "databaseBytes": sum(path.stat().st_size for path in files if path.exists())}


def info(db_path: str) -> dict:
    """What Finance's "Test connection" shows: which server, how many sources, how fresh."""
    with connect(db_path) as db:
        sources = db.execute("SELECT COUNT(*) FROM source_status").fetchone()[0]
        last = db.execute("SELECT MAX(ts_ms) FROM portfolio_samples").fetchone()[0]
    retention = retention_settings()
    return {"name": "atmos-portfolio", "version": VERSION, "apiVersion": API_VERSION,
            "sources": sources, "lastUpdate": last,
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
    find the holdings behind every point Finance draws."""
    cursor = db.execute(
        """
        DELETE FROM holdings_history
        WHERE ts_ms >= ? AND ts_ms < ?
          AND ts_ms NOT IN (
            SELECT MAX(ts_ms) FROM portfolio_samples
            WHERE ts_ms >= ? AND ts_ms < ? GROUP BY ts_ms / ?
          )
        """,
        (start_ms, end_ms, start_ms, end_ms, bucket_ms),
    )
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
        oldest = db.execute("SELECT MIN(ts_ms) FROM holdings_history").fetchone()[0]
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
    base64url JSON {url, token}. It contains the token: treat it like one."""
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

    def send_json(self, status: HTTPStatus, payload: object) -> None:
        body = json.dumps(payload, separators=(",", ":")).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        self.wfile.write(body)

    def authorized(self) -> bool:
        expected = self.server.api_token
        supplied = self.headers.get("Authorization", "")
        return bool(expected) and hmac.compare_digest(supplied, "Bearer " + expected)

    def do_GET(self) -> None:
        parsed = urlparse(self.path)
        if parsed.path == "/health":
            # Unauthenticated, so it says only that the service is up.
            self.send_json(HTTPStatus.OK, {"status": "ok", "version": VERSION})
            return
        if not self.authorized():
            self.send_json(HTTPStatus.UNAUTHORIZED, {"error": "unauthorized"})
            return
        try:
            self.route(parsed)
        except ValueError as error:
            self.send_json(HTTPStatus.BAD_REQUEST, {"error": str(error)})

    def route(self, parsed) -> None:
        if parsed.path == "/v1/info":
            self.send_json(HTTPStatus.OK, info(self.server.db_path))
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
                if separator and source_id and group in ("perp", "earn"):
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
            points = holdings_history(self.server.db_path, start_ms, end_ms, source_id, symbol)
            self.send_json(HTTPStatus.OK, {
                "points": points,
                "truncated": len(points) >= MAX_HOLDINGS_HISTORY_ROWS,
            })
            return
        self.send_json(HTTPStatus.NOT_FOUND, {"error": "not found"})


def serve(db_path: str) -> None:
    migrate(db_path)
    host = os.environ.get("ATMOS_PORTFOLIO_HOST", "127.0.0.1")
    port = int(os.environ.get("ATMOS_PORTFOLIO_PORT", "8787"))
    token = os.environ.get("ATMOS_PORTFOLIO_TOKEN", "")
    if len(token) < 32:
        raise SystemExit("ATMOS_PORTFOLIO_TOKEN must contain at least 32 characters")
    server = ThreadingHTTPServer((host, port), ApiHandler)
    server.db_path = db_path
    server.api_token = token
    server.serve_forever()


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("command", choices=("init", "serve", "ingest", "status", "integrity", "pairing", "prune", "backup"))
    parser.add_argument("--db", default=os.environ.get("ATMOS_PORTFOLIO_DB", DEFAULT_DB))
    parser.add_argument("--file", help="JSON frame; omit to read stdin")
    parser.add_argument("--url", help="pairing: the address Finance should use (default: ATMOS_PORTFOLIO_PUBLIC_URL, or the bind address)")
    parser.add_argument("--env-file", default="/etc/atmos-portfolio.env", help="pairing: where the token and address are configured")
    parser.add_argument("--vacuum", action="store_true", help="prune: also give freed space back to the filesystem")
    parser.add_argument("--out", help="backup: the file to write (must not exist)")
    args = parser.parse_args()
    if args.command == "pairing":
        settings = dict(os.environ)
        if Path(args.env_file).exists():
            settings.update(read_env_file(args.env_file))
        try:
            print(pairing_code(args.url or default_url(settings), settings.get("ATMOS_PORTFOLIO_TOKEN", "")))
        except ValueError as error:
            raise SystemExit(f"pairing: {error}")
        return
    migrate(args.db)
    if args.command == "serve":
        serve(args.db)
    elif args.command == "ingest":
        raw = json.loads(Path(args.file).read_text() if args.file else sys.stdin.read())
        frame = ingest(args.db, raw)
        print(json.dumps({"timestamp": frame["ts_ms"], "sources": len(frame["sources"])}))
    elif args.command == "prune":
        settings = dict(os.environ)
        if Path(args.env_file).exists():
            settings.update(read_env_file(args.env_file))
        print(json.dumps(prune(args.db, settings=retention_settings(settings), vacuum=args.vacuum)))
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
