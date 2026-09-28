#!/usr/bin/env python3
"""Runs the Atmos portfolio backend's connectors (connectors/) on a schedule
and stores what they find (server.py).

Only the Python standard library is used. Secrets are loaded from a protected
JSON file and are never included in logs, exceptions, database rows, or API
responses.

    collectors.py                       collect every poll_seconds (the service)
    collectors.py --once                collect once
    collectors.py --status              sources, errors and holdings stored
    collectors.py connectors            every connector's declaration, as JSON
    collectors.py example-config        a configuration with every source disabled
    collectors.py configure [--output FILE]
                                        ask for each source's settings (masked)
                                        and write the configuration
"""

from __future__ import annotations

import getpass
import json
import os
import sys
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
from typing import Any

import connectors
import server
from connectors.shared import CollectorError

DEFAULT_CONFIG = "/etc/atmos-portfolio-sources.json"
DEFAULT_POLL_SECONDS = 60


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
    """Enabled sources with a connector, by source id."""
    return {source_id: values for source_id, values in config.get("sources", {}).items()
            if isinstance(values, dict) and values.get("enabled", True)
            and connectors.connector_for(source_id, values) is not None}


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
    with ThreadPoolExecutor(max_workers=min(4, len(active)), thread_name_prefix="collector") as pool:
        futures = {pool.submit(connectors.collect, source_id, values): source_id for source_id, values in active.items()}
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


def configure(output: str | None) -> None:
    """Ask for every connector's settings, masked, and write the configuration."""
    print("Atmos portfolio sources. Answers are masked (apart from account names); leave a source\n"
          "blank to keep it disabled. After each source you use, you can add another account of it.",
          file=sys.stderr)
    def ask(prompt: str, secret: bool = True) -> str:
        if secret:
            return getpass.getpass(f"{prompt}: ")
        print(f"{prompt}: ", end="", file=sys.stderr, flush=True)  # stdout may be the configuration
        return sys.stdin.readline()

    try:
        config = connectors.build_config(ask)
    except ValueError as error:
        raise SystemExit(str(error)) from None
    text = json.dumps(config, indent=2) + "\n"
    if not output:
        sys.stdout.write(text)
        return
    previous = os.umask(0o077)
    try:
        temporary = Path(f"{output}.tmp")
        temporary.write_text(text, encoding="utf-8")
        # Replacing a configuration keeps who may read it (the service's group).
        if os.path.exists(output):
            existing = os.stat(output)
            try:
                os.chown(temporary, existing.st_uid, existing.st_gid)
            except PermissionError:
                pass
            os.chmod(temporary, existing.st_mode & 0o777)
        os.replace(temporary, output)
    finally:
        os.umask(previous)
    print(f"Written to {output}.", file=sys.stderr)


def main() -> None:
    db_path = os.environ.get("ATMOS_PORTFOLIO_DB", server.DEFAULT_DB)
    command = sys.argv[1] if len(sys.argv) > 1 and not sys.argv[1].startswith("-") else ""
    if command == "connectors":
        print(json.dumps(connectors.describe(), indent=2))
    elif command == "example-config":
        print(json.dumps(connectors.example_config(), indent=2))
    elif command == "configure":
        output = sys.argv[sys.argv.index("--output") + 1] if "--output" in sys.argv[:-1] else None
        configure(output)
    elif command:
        raise SystemExit(f"unknown command {command!r}; see the top of collectors.py")
    elif "--status" in sys.argv:
        print_status(db_path)
    else:
        run(
            os.environ.get("ATMOS_PORTFOLIO_SOURCES", DEFAULT_CONFIG),
            db_path,
            "--once" in sys.argv,
        )


if __name__ == "__main__":
    main()
