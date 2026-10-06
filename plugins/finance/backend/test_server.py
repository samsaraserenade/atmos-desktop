import json
import sqlite3
import tempfile
import unittest
from pathlib import Path

import server


class StoreTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.db = str(Path(self.temp.name) / "test.sqlite3")
        server.migrate(self.db)

    def tearDown(self):
        self.temp.cleanup()

    def test_ingest_latest_and_history(self):
        server.ingest(self.db, {
            "ts_ms": 1000,
            "currency": "USD",
            "sources": [{
                "id": "wallet", "label": "Wallet", "value": 12,
                "holdings": [
                    {"symbol": "SOL", "value": 10},
                    {"symbol": "USDC", "value": 2, "kind": "cash"},
                ],
            }],
        })
        current = server.latest(self.db)
        self.assertEqual(current["total"], 12)
        self.assertEqual(current["invested"], 10)
        self.assertEqual(current["cash"], 2)
        self.assertEqual(len(current["holdings"]), 2)
        self.assertEqual(server.history(self.db, 0, 2000, "raw")[0]["v"], 12)
        self.assertEqual(server.integrity_check(self.db), "ok")

    def test_history_bucketing_uses_latest_sample(self):
        for ts, value in ((1000, 1), (2000, 2), (301000, 3)):
            server.ingest(self.db, {"ts_ms": ts, "sources": [{"id": "x", "value": value}]})
        rows = server.history(self.db, 0, 400000, "5m")
        self.assertEqual([row["v"] for row in rows], [2, 3])

    def test_portfolio_and_history_expose_cash_invested_ratios(self):
        server.ingest(self.db, {"ts_ms": 1000, "sources": [{
            "id": "wallet", "value": 100,
            "holdings": [
                {"symbol": "SOL", "value": 75, "kind": "invested"},
                {"symbol": "USDC", "value": 25, "kind": "cash"},
            ],
        }]})
        current = server.latest(self.db)
        self.assertAlmostEqual(current["investedRatio"], 0.75)
        self.assertAlmostEqual(current["cashRatio"], 0.25)
        point = server.history(self.db, 0, 2000, "raw")[0]
        self.assertAlmostEqual(point["investedRatio"], 0.75)
        self.assertAlmostEqual(point["cashRatio"], 0.25)

    def test_history_can_recompute_totals_with_individual_holdings_excluded(self):
        server.ingest(self.db, {"ts_ms": 1000, "sources": [{
            "id": "wallet", "value": 100,
            "holdings": [
                {"id": "spot", "symbol": "SOL", "value": 60, "kind": "invested", "meta": {"instrument": "spot"}},
                {"id": "earn", "symbol": "USDC Earn", "value": 40, "kind": "cash", "meta": {"instrument": "perp-cash", "account": "earn"}},
            ],
        }]})
        point = server.history(self.db, 0, 2000, "raw", {("wallet", "earn")})[0]
        self.assertEqual(point["v"], 60)
        self.assertEqual(point["spot"], 60)
        self.assertEqual(point["perp"], 0)
        self.assertEqual(point["invested"], 60)
        self.assertEqual(point["cash"], 0)
        self.assertEqual(point["investedRatio"], 1)

        source_point = server.history(self.db, 0, 2000, "raw", set(), {"wallet"})[0]
        self.assertEqual(source_point["v"], 0)
        self.assertEqual(source_point["spot"], 0)
        self.assertEqual(source_point["perp"], 0)

    def test_excluded_holdings_are_read_only_at_the_samples_returned(self):
        # A coin's history in Finance is the total less the total without it:
        # exact at every point, and the holdings behind each point read by
        # its sample, a chunk of samples at a time (0.9.1).
        from unittest import mock
        for i in range(10):
            server.ingest(self.db, {"ts_ms": 1000 + i * 60_000, "sources": [{"id": "wallet", "value": 100 + i, "holdings": [
                {"id": "sol", "symbol": "SOL", "value": 10 + i, "kind": "invested"},
                {"id": "usdc", "symbol": "USDC", "value": 90, "kind": "cash"},
            ]}]})
        full = server.history(self.db, 0, 10**7, "5m")
        less = server.history(self.db, 0, 10**7, "5m", {("wallet", "sol")})
        self.assertEqual([p["t"] for p in full], [241_000, 541_000], "each bucket's newest sample")
        self.assertEqual([p["t"] for p in less], [p["t"] for p in full])
        self.assertEqual([a["v"] - b["v"] for a, b in zip(full, less)], [14, 19], "SOL's value at those samples")
        with mock.patch.object(server, "SAMPLES_PER_QUERY", 1):
            self.assertEqual(server.history(self.db, 0, 10**7, "5m", {("wallet", "sol")}), less)
        raw = server.history(self.db, 0, 10**7, "raw", {("wallet", "sol")})
        self.assertEqual([p["v"] for p in raw], [90] * 10)

    def test_position_exclusion_does_not_remove_shared_account_capital(self):
        server.ingest(self.db, {"ts_ms": 1000, "sources": [{
            "id": "hyperliquid-wallet", "value": 100,
            "holdings": [
                {"id": "cash", "symbol": "USDC", "value": 70, "kind": "cash", "meta": {"instrument": "perp-cash"}},
                {"id": "position", "symbol": "BTC Perp", "value": 30, "meta": {"instrument": "perp"}},
            ],
        }]})
        for legacy_key in ("position", "cash"):
            with self.subTest(legacy_key=legacy_key):
                point = server.history(
                    self.db, 0, 2000, "raw", {("hyperliquid-wallet", legacy_key)},
                )[0]
                self.assertEqual(point["v"], 100)
                self.assertEqual(point["perp"], 100)

    def test_hyperliquid_history_filters_stable_perp_and_earn_balances(self):
        server.ingest(self.db, {"ts_ms": 1000, "sources": [{
            "id": "hyperliquid-wallet", "value": 120,
            "holdings": [
                {"id": "cash", "symbol": "USDC", "value": 50, "kind": "cash", "meta": {"instrument": "perp-cash"}},
                {"id": "position", "symbol": "BTC Perp", "value": 30, "meta": {"instrument": "perp"}},
                {"id": "earn", "symbol": "USDC Earn", "value": 40, "kind": "cash", "meta": {"instrument": "perp-cash", "account": "earn"}},
            ],
        }]})
        without_perp = server.history(
            self.db, 0, 2000, "raw", set(), set(), {("hyperliquid-wallet", "perp")},
        )[0]
        self.assertEqual(without_perp["v"], 40)
        self.assertEqual(without_perp["perp"], 40)
        without_earn = server.history(
            self.db, 0, 2000, "raw", set(), set(), {("hyperliquid-wallet", "earn")},
        )[0]
        self.assertEqual(without_earn["v"], 80)
        self.assertEqual(without_earn["perp"], 80)

    def test_empty_portfolio_ratios_do_not_divide_by_zero(self):
        current = server.latest(self.db)
        self.assertEqual(current["investedRatio"], 0.0)
        self.assertEqual(current["cashRatio"], 0.0)

    def test_holdings_history_retains_quantity_and_price_across_polls(self):
        server.ingest(self.db, {"ts_ms": 1000, "sources": [{
            "id": "wallet", "value": 100,
            "holdings": [{"symbol": "SOL", "quantity": 2, "price": 50, "value": 100, "kind": "invested"}],
        }]})
        server.ingest(self.db, {"ts_ms": 2000, "sources": [{
            "id": "wallet", "value": 220,
            "holdings": [{"symbol": "SOL", "quantity": 4, "price": 55, "value": 220, "kind": "invested"}],
        }]})
        points = server.holdings_history(self.db, 0, 5000)
        self.assertEqual(len(points), 2)
        self.assertEqual(points[0]["quantity"], 2)
        self.assertEqual(points[0]["price"], 50)
        self.assertEqual(points[1]["quantity"], 4)
        self.assertEqual(points[1]["price"], 55)
        # current_holdings (latest-only view) should reflect the second poll.
        current = server.latest(self.db)
        sol = next(h for h in current["holdings"] if h["symbol"] == "SOL")
        self.assertEqual(sol["quantity"], 4)
        self.assertEqual(sol["price"], 55)

    def test_holdings_history_filters_by_source_and_symbol(self):
        server.ingest(self.db, {"ts_ms": 1000, "sources": [
            {"id": "wallet-a", "value": 10, "holdings": [{"symbol": "SOL", "quantity": 1, "price": 10, "value": 10}]},
            {"id": "wallet-b", "value": 20, "holdings": [{"symbol": "ADA", "quantity": 40, "price": 0.5, "value": 20}]},
        ]})
        only_a = server.holdings_history(self.db, 0, 5000, source_id="wallet-a")
        self.assertEqual([p["source_id"] for p in only_a], ["wallet-a"])
        only_ada = server.holdings_history(self.db, 0, 5000, symbol="ADA")
        self.assertEqual([p["symbol"] for p in only_ada], ["ADA"])

    def test_holdings_without_quantity_or_price_still_ingest(self):
        # Backward compatibility: a caller that only ever sends a value
        # (no quantity/price) must not break ingest or totals.
        server.ingest(self.db, {"ts_ms": 1000, "sources": [{
            "id": "wallet", "value": 12,
            "holdings": [{"symbol": "SOL", "value": 12}],
        }]})
        current = server.latest(self.db)
        self.assertEqual(current["total"], 12)
        sol = current["holdings"][0]
        self.assertEqual(sol["quantity"], 12)
        self.assertEqual(sol["price"], 1.0)

    def test_same_asset_in_two_wallets_keeps_both_capital_locations(self):
        server.ingest(self.db, {"ts_ms": 1000, "sources": [{
            "id": "solana-wallet", "value": 30,
            "holdings": [
                {"id": "wallet-a:token:usdc", "symbol": "USDC", "quantity": 10, "price": 1, "value": 10, "kind": "cash", "meta": {"walletAddress": "wallet-a"}},
                {"id": "wallet-b:token:usdc", "symbol": "USDC", "quantity": 20, "price": 1, "value": 20, "kind": "cash", "meta": {"walletAddress": "wallet-b"}},
            ],
        }]})
        current = server.latest(self.db)
        self.assertEqual(len(current["holdings"]), 2)
        self.assertEqual({row["holding_id"] for row in current["holdings"]}, {"wallet-a:token:usdc", "wallet-b:token:usdc"})
        self.assertEqual({row["meta"]["walletAddress"] for row in current["holdings"]}, {"wallet-a", "wallet-b"})

    def test_migration_preserves_pre_holding_id_rows(self):
        old_db = str(Path(self.temp.name) / "old.sqlite3")
        db = sqlite3.connect(old_db)
        try:
            db.executescript("""
              CREATE TABLE current_holdings (
                source_id TEXT NOT NULL, symbol TEXT NOT NULL, kind TEXT NOT NULL,
                value REAL NOT NULL, currency TEXT NOT NULL, updated_at_ms INTEGER NOT NULL,
                quantity REAL NOT NULL DEFAULT 0, price REAL NOT NULL DEFAULT 0, meta TEXT,
                PRIMARY KEY(source_id, symbol, kind)
              ) WITHOUT ROWID;
              CREATE TABLE holdings_history (
                ts_ms INTEGER NOT NULL, source_id TEXT NOT NULL, symbol TEXT NOT NULL, kind TEXT NOT NULL,
                quantity REAL NOT NULL, price REAL NOT NULL, value REAL NOT NULL, currency TEXT NOT NULL, meta TEXT,
                PRIMARY KEY(ts_ms, source_id, symbol, kind)
              ) WITHOUT ROWID;
              INSERT INTO current_holdings VALUES ('wallet','SOL','invested',10,'USD',1000,1,10,NULL);
              INSERT INTO holdings_history VALUES (1000,'wallet','SOL','invested',1,10,10,'USD',NULL);
            """)
            db.commit()
        finally:
            db.close()
        server.migrate(old_db)
        with server.connect(old_db) as db:
            current_id = db.execute("SELECT holding_id FROM current_holdings").fetchone()[0]
        history = server.holdings_history(old_db, 0, 2000)
        self.assertEqual(current_id, "SOL:invested")
        self.assertEqual(history[0]["holding_id"], "SOL:invested")
        self.assertEqual(server.integrity_check(old_db), "ok")

    def test_a_sample_from_the_future_is_refused(self):
        # Review of R10: a sample dated ahead (a wrong ts_ms imported) would
        # stay the newest, and its holdings the current ones, until then.
        import time as clock
        ahead = int(clock.time() * 1000) + 3_600_000
        with self.assertRaises(ValueError):
            server.ingest(self.db, {"ts_ms": ahead, "sources": [{"id": "w", "value": 1}]})
        self.assertIsNone(server.latest(self.db)["timestamp"])
        server.ingest(self.db, {"ts_ms": int(clock.time() * 1000) + 60_000, "sources": [{"id": "w", "value": 1}]})

    def test_an_older_sample_arriving_late_doesnt_replace_the_current_holdings(self):
        # R10: every ingestion rewrote current holdings and source status,
        # whatever its time, while latest() takes the newest total.
        server.ingest(self.db, {"ts_ms": 2000, "sources": [{"id": "w", "value": 40, "holdings": [{"symbol": "ETH", "value": 40}]}]})
        server.ingest(self.db, {"ts_ms": 1000, "sources": [{"id": "w", "value": 20, "holdings": [{"symbol": "SOL", "value": 20}]}]})
        current = server.latest(self.db)
        self.assertEqual(current["timestamp"], 2000)
        self.assertEqual([(h["symbol"], h["value"]) for h in current["holdings"]], [("ETH", 40.0)])
        self.assertEqual(current["sources"][0]["value"], 40)
        # The late sample is still history.
        self.assertEqual([row["symbol"] for row in server.holdings_history(self.db, 1000, 1000)], ["SOL"])

    def test_a_replaced_sample_leaves_none_of_its_old_holdings_in_history(self):
        # R11: samples are replaced by time, holdings history only holding by
        # holding, so A replaced by B gave current [B] but history [A, B].
        server.ingest(self.db, {"ts_ms": 1000, "sources": [{"id": "w", "value": 10, "holdings": [{"symbol": "AAA", "value": 10}]}]})
        server.ingest(self.db, {"ts_ms": 1000, "sources": [{"id": "w", "value": 10, "holdings": [{"symbol": "BBB", "value": 10}]}]})
        self.assertEqual([row["symbol"] for row in server.latest(self.db)["holdings"]], ["BBB"])
        self.assertEqual([row["symbol"] for row in server.holdings_history(self.db, 1000, 1000)], ["BBB"])

    def test_latest_reads_one_snapshot_while_a_collection_commits(self):
        # R9: totals, sources and holdings were three reads; a collection
        # committing between them gave a $20 total with $40 of holdings.
        snapshot = lambda ts, value: {"ts_ms": ts, "sources": [{"id": "w", "value": value, "holdings": [{"symbol": "SOL", "value": value}]}]}
        server.ingest(self.db, snapshot(1000, 20))
        real_connect = server.connect
        db_path = self.db

        class CollectionMidRead:
            def __init__(self, db):
                self.db, self.done = db, False
            def __enter__(self):
                self.db.__enter__()
                return self
            def __exit__(self, *args):
                return self.db.__exit__(*args)
            def execute(self, sql, *args):
                cursor = self.db.execute(sql, *args)
                if not self.done and "portfolio_samples" in sql:
                    rows = cursor.fetchall()
                    self.done = True
                    server.connect = real_connect
                    server.ingest(db_path, snapshot(2000, 40))  # another process's collection commits now
                    return iter_rows(rows)
                return cursor

        class iter_rows(list):
            def fetchone(self):
                return self[0] if self else None

        server.connect = lambda path: CollectionMidRead(real_connect(path))
        try:
            current = server.latest(self.db)
        finally:
            server.connect = real_connect
        values = (current["total"], current["sources"][0]["value"], current["holdings"][0]["value"])
        self.assertIn(values, [(20, 20, 20), (40, 40, 40)], "one snapshot, whichever it is")

    def test_a_migration_interrupted_anywhere_loses_nothing(self):
        # R6: the table rebuilds ran statement by statement; stopped after
        # the replacement table was made, it stayed empty while the rows sat
        # in the *_legacy table, and the next start saw the new shape and
        # never looked back. SQLite's progress handler stops the migration
        # at each point in turn, as a crash or a kill would; then it runs
        # again, as the next start does.
        def old_database(path):
            db = sqlite3.connect(path)
            try:
                db.executescript("""
                  CREATE TABLE current_holdings (
                    source_id TEXT NOT NULL, symbol TEXT NOT NULL, kind TEXT NOT NULL,
                    value REAL NOT NULL, currency TEXT NOT NULL, updated_at_ms INTEGER NOT NULL,
                    quantity REAL NOT NULL DEFAULT 0, price REAL NOT NULL DEFAULT 0, meta TEXT,
                    PRIMARY KEY(source_id, symbol, kind)
                  ) WITHOUT ROWID;
                  CREATE TABLE holdings_history (
                    ts_ms INTEGER NOT NULL, source_id TEXT NOT NULL, symbol TEXT NOT NULL, kind TEXT NOT NULL,
                    quantity REAL NOT NULL, price REAL NOT NULL, value REAL NOT NULL, currency TEXT NOT NULL, meta TEXT,
                    PRIMARY KEY(ts_ms, source_id, symbol, kind)
                  ) WITHOUT ROWID;
                  INSERT INTO current_holdings VALUES ('wallet','SOL','invested',10,'USD',1000,1,10,NULL);
                  INSERT INTO holdings_history VALUES (1000,'wallet','SOL','invested',1,10,10,'USD',NULL);
                  INSERT INTO holdings_history VALUES (2000,'wallet','SOL','invested',2,10,20,'USD',NULL);
                """)
                db.commit()
            finally:
                db.close()

        real_connect = server.connect
        stop_at = [0]

        def interrupting_connect(path):
            db = real_connect(path)
            calls = [0]

            def tick():
                calls[0] += 1
                return 1 if calls[0] == stop_at[0] else 0
            db.set_progress_handler(tick, 10)
            return db

        stopped = 0
        for step in range(1, 5000):
            path = str(Path(self.temp.name) / f"interrupted-{step}.sqlite3")
            old_database(path)
            stop_at[0] = step
            server.connect = interrupting_connect
            try:
                server.migrate(path)
                finished = True
            except sqlite3.OperationalError:
                finished = False
            finally:
                server.connect = real_connect
            server.migrate(path)
            with self.subTest(step=step):
                with server.connect(path) as db:
                    tables = {row[0] for row in db.execute("SELECT name FROM sqlite_master WHERE type = 'table'")}
                    current = [tuple(row) for row in db.execute("SELECT holding_id, value FROM current_holdings")]
                history = [(row["ts_ms"], row["holding_id"], row["value"]) for row in server.holdings_history(path, 0, 3000)]
                self.assertEqual(current, [("SOL:invested", 10.0)])
                self.assertEqual(history, [(1000, "SOL:invested", 10.0), (2000, "SOL:invested", 20.0)])
                self.assertFalse({"current_holdings_legacy", "holdings_history_legacy"} & tables)
            Path(path).unlink()
            if finished:
                break
            stopped += 1
        self.assertGreater(stopped, 20)

    def test_an_upgrade_names_the_polls_already_recorded(self):
        # R12: polls are recorded from this version on; the ones before are
        # the times holdings_history already has (an empty one left none).
        server.ingest(self.db, {"ts_ms": 1000, "sources": [{"id": "w", "value": 1, "holdings": [{"symbol": "SOL", "value": 1}]}]})
        server.ingest(self.db, {"ts_ms": 2000, "sources": [{"id": "w", "value": 0, "holdings": []}]})
        with server.connect(self.db) as db:
            db.execute("DROP TABLE holdings_polls")
        server.migrate(self.db)
        self.assertEqual(server.holdings_history_page(self.db, 0, 3000)[1], [1000])
        server.migrate(self.db)
        server.ingest(self.db, {"ts_ms": 3000, "sources": [{"id": "w", "value": 0, "holdings": []}]})
        self.assertEqual(server.holdings_history_page(self.db, 0, 3000)[1], [1000, 3000])

    def test_two_starts_at_once_both_list_the_polls(self):
        # Review of R12: the table was checked for outside the transaction
        # that made it, so of two migrations at once one failed.
        from unittest import mock
        has_table = server._has_table
        with mock.patch.object(server, "_has_table", side_effect=lambda db, name: False if name == "holdings_polls" else has_table(db, name)):
            server.migrate(self.db)  # as if the other made it after the check
        server.ingest(self.db, {"ts_ms": 1000, "sources": []})
        self.assertEqual(server.holdings_history_page(self.db, 0, 2000)[1], [1000])

    def test_rows_an_older_server_left_in_legacy_tables_come_back(self):
        # What 0.9.1 could leave after a rebuild stopped part-way (R6): the
        # rows in *_legacy, the new tables empty or with what was collected
        # since.
        path = str(Path(self.temp.name) / "stranded.sqlite3")
        server.migrate(path)
        with server.connect(path) as db:
            db.executescript("""
              CREATE TABLE current_holdings_legacy (
                source_id TEXT NOT NULL, symbol TEXT NOT NULL, kind TEXT NOT NULL,
                value REAL NOT NULL, currency TEXT NOT NULL, updated_at_ms INTEGER NOT NULL,
                quantity REAL NOT NULL DEFAULT 0, price REAL NOT NULL DEFAULT 0, meta TEXT,
                PRIMARY KEY(source_id, symbol, kind)
              ) WITHOUT ROWID;
              CREATE TABLE holdings_history_legacy (
                ts_ms INTEGER NOT NULL, source_id TEXT NOT NULL, symbol TEXT NOT NULL, kind TEXT NOT NULL,
                quantity REAL NOT NULL, price REAL NOT NULL, value REAL NOT NULL, currency TEXT NOT NULL, meta TEXT,
                PRIMARY KEY(ts_ms, source_id, symbol, kind)
              ) WITHOUT ROWID;
              INSERT INTO current_holdings_legacy VALUES ('wallet','SOL','invested',10,'USD',1000,1,10,NULL);
              INSERT INTO current_holdings_legacy VALUES ('exchange','BTC','invested',50,'USD',1000,1,50,NULL);
              INSERT INTO holdings_history_legacy VALUES (1000,'wallet','SOL','invested',1,10,10,'USD',NULL);
              INSERT INTO holdings_history_legacy VALUES (2000,'exchange','BTC','invested',1,40,40,'USD',NULL);
              -- Collected since: the exchange's newer holdings, and its row at 2000 already moved.
              INSERT INTO current_holdings (source_id,holding_id,symbol,kind,value,currency,updated_at_ms)
                VALUES ('exchange','btc','BTC','invested',60,'USD',3000);
              INSERT INTO holdings_history (ts_ms,source_id,holding_id,symbol,kind,quantity,price,value,currency)
                VALUES (2000,'exchange','BTC:invested','BTC','invested',1,40,40,'USD');
            """)
        server.migrate(path)
        with server.connect(path) as db:
            current = sorted(tuple(row) for row in db.execute("SELECT source_id, holding_id, value FROM current_holdings"))
            tables = {row[0] for row in db.execute("SELECT name FROM sqlite_master WHERE type = 'table'")}
        history = [(row["ts_ms"], row["holding_id"], row["value"]) for row in server.holdings_history(path, 0, 3000)]
        self.assertEqual(current, [("exchange", "btc", 60.0), ("wallet", "SOL:invested", 10.0)])
        self.assertEqual(history, [(1000, "SOL:invested", 10.0), (2000, "BTC:invested", 40.0)])
        self.assertFalse({"current_holdings_legacy", "holdings_history_legacy"} & tables)


if __name__ == "__main__":
    unittest.main()

class ApiTests(unittest.TestCase):
    """The HTTP routes Finance uses to pair and read, on a real socket."""

    TOKEN = "k" * 40

    def setUp(self):
        import threading
        from http.server import ThreadingHTTPServer
        self.temp = tempfile.TemporaryDirectory()
        self.db = str(Path(self.temp.name) / "api.sqlite3")
        server.migrate(self.db)
        server.ingest(self.db, {"ts_ms": 5000, "sources": [{"id": "a", "value": 1}, {"id": "b", "value": 2}]})
        self.httpd = ThreadingHTTPServer(("127.0.0.1", 0), server.ApiHandler)
        self.httpd.db_path = self.db
        self.httpd.api_token = self.TOKEN
        self.httpd.log_message = lambda *args: None
        server.ApiHandler.log_message = lambda *args: None
        threading.Thread(target=self.httpd.serve_forever, daemon=True).start()
        self.base = f"http://127.0.0.1:{self.httpd.server_address[1]}"

    def tearDown(self):
        self.httpd.shutdown()
        self.httpd.server_close()
        self.temp.cleanup()

    def get(self, path, token=TOKEN):
        from urllib.error import HTTPError
        from urllib.request import Request, urlopen
        request = Request(self.base + path, headers={"Authorization": f"Bearer {token}"} if token else {})
        try:
            with urlopen(request, timeout=5) as response:
                return response.status, json.loads(response.read())
        except HTTPError as error:
            return error.code, json.loads(error.read())

    def test_health_is_public_but_says_only_that_it_is_up(self):
        status, body = self.get("/health", token=None)
        self.assertEqual(status, 200)
        self.assertEqual(body, {"status": "ok", "version": server.VERSION})

    def test_info_identifies_the_server_for_finance(self):
        self.assertEqual(self.get("/v1/info", token=None)[0], 401)
        self.assertEqual(self.get("/v1/info", token="x" * 40)[0], 401)
        status, body = self.get("/v1/info")
        self.assertEqual(status, 200)
        self.assertEqual(body, {"name": "atmos-portfolio", "version": server.VERSION, "apiVersion": 1,
                                "device": "shared token", "sources": 2, "lastUpdate": 5000,
                                "retention": {"holdingsRawDays": 30, "holdingsHourlyDays": 365}})

    def test_each_device_has_its_own_token_and_can_be_revoked(self):
        _, laptop = server.add_device(self.db, "laptop")
        _, phone = server.add_device(self.db, "phone")
        self.assertEqual(self.get("/v1/info", token=laptop)[1]["device"], "laptop")
        self.assertEqual(self.get("/v1/portfolio", token=phone)[0], 200)
        self.assertTrue(server.revoke_device(self.db, "laptop"))
        self.assertEqual(self.get("/v1/info", token=laptop)[0], 401)
        self.assertEqual(self.get("/v1/info", token=phone)[1]["device"], "phone")

    def test_without_the_shared_token_only_devices_get_in(self):
        self.httpd.api_token = ""
        _, token = server.add_device(self.db, "laptop")
        self.assertEqual(self.get("/v1/info")[0], 401)
        self.assertEqual(self.get("/v1/info", token="")[0], 401)
        self.assertEqual(self.get("/v1/info", token=token)[0], 200)

    def test_only_a_bearer_header_is_read(self):
        from urllib.error import HTTPError
        from urllib.request import Request, urlopen
        _, token = server.add_device(self.db, "laptop")
        for header in (token, f"Basic {token}", f"bearer {token}", f"Bearer  {token}"):
            with self.assertRaises(HTTPError, msg=header) as caught:
                urlopen(Request(self.base + "/v1/info", headers={"Authorization": header}), timeout=5)
            self.assertEqual(caught.exception.code, 401)

    def test_bad_times_are_a_400_not_a_dropped_connection(self):
        status, body = self.get("/v1/history?from=yesterday")
        self.assertEqual(status, 400)
        self.assertIn("from", body["error"])
        self.assertEqual(self.get("/v1/holdings-history?to=soon")[0], 400)
        self.assertEqual(self.get("/v1/history?from=0&to=9999")[0], 200)

    def test_answers_are_logged_with_their_time_and_size_never_the_query(self):
        from unittest import mock
        lines = []
        with mock.patch.object(server.ApiHandler, "log_message", lambda handler, fmt, *args: lines.append(fmt % args)):
            self.assertEqual(self.get("/v1/history?from=0&to=9999&exclude=wallet%7Csecret-coin")[0], 200)
            # The server logs once the answer is sent, so the client can be
            # back first: wait for the line.
            import time as clock
            deadline = clock.monotonic() + 5
            while not lines and clock.monotonic() < deadline:
                clock.sleep(0.01)
        self.assertEqual(len(lines), 1)
        self.assertRegex(lines[0], r"^/v1/history 200 \d+ ms \d+ bytes$")
        self.assertNotIn("secret", lines[0])

    def test_holdings_history_sends_whole_polls_newest_first_when_asked(self):
        # R7: past the row limit the server sent the oldest rows, the last
        # poll cut part-way, so "the newest poll before T" came out older
        # and incomplete.
        from unittest import mock
        for minute in range(1, 7):
            server.ingest(self.db, {"ts_ms": minute * 60_000, "sources": [{"id": "w", "value": 3, "holdings": [
                {"symbol": "SOL", "value": 1}, {"symbol": "ETH", "value": 1}, {"symbol": "BTC", "value": 1}]}]})
        with mock.patch.object(server, "MAX_HOLDINGS_HISTORY_ROWS", 5):
            status, newest = self.get("/v1/holdings-history?from=0&to=400000&order=desc")
            _, oldest = self.get("/v1/holdings-history?from=0&to=400000")
        self.assertEqual(status, 200)
        self.assertEqual(newest["order"], "desc")
        self.assertTrue(newest["truncated"])
        times = [point["ts_ms"] for point in newest["points"]]
        self.assertEqual(times, [360_000] * 3, "the newest poll, whole")
        self.assertEqual(oldest["order"], "asc")
        self.assertTrue(oldest["truncated"])
        self.assertEqual([point["ts_ms"] for point in oldest["points"]], [60_000] * 3, "whole polls only, the cut one left for the next page")

    def test_holdings_history_names_its_polls_so_an_empty_one_shows(self):
        # R12: a poll with no holdings wrote a sample but no holdings rows,
        # so "what was held at 2000" found the holding from before ($100).
        server.ingest(self.db, {"ts_ms": 1_000_000, "sources": [{"id": "w", "value": 100, "holdings": [{"symbol": "SOL", "value": 100}]}]})
        server.ingest(self.db, {"ts_ms": 2_000_000, "sources": [{"id": "w", "value": 0, "holdings": []}]})
        _, answer = self.get("/v1/holdings-history?from=900000&to=2500000&order=desc")
        self.assertEqual(answer["polls"], [2_000_000, 1_000_000], "every poll in the range, holdings or not")
        self.assertEqual([point["ts_ms"] for point in answer["points"]], [1_000_000])

    def test_holdings_history_polls_end_where_its_points_do(self):
        # R12: a page names only the polls it covers whole, whichever of
        # rows or polls the limit cuts first.
        from unittest import mock
        server.ingest(self.db, {"ts_ms": 60_000, "sources": [{"id": "w", "value": 1, "holdings": [{"symbol": "SOL", "value": 1}]}]})
        for minute in range(2, 7):
            server.ingest(self.db, {"ts_ms": minute * 60_000, "sources": [{"id": "w", "value": 0, "holdings": []}]})
        with mock.patch.object(server, "MAX_HOLDINGS_HISTORY_ROWS", 3):
            _, oldest = self.get("/v1/holdings-history?from=10000&to=400000")
            _, newest = self.get("/v1/holdings-history?from=10000&to=400000&order=desc")
        self.assertEqual((oldest["polls"], len(oldest["points"]), oldest["truncated"]), ([60_000, 120_000, 180_000], 1, True))
        self.assertEqual((newest["polls"], newest["points"], newest["truncated"]), ([360_000, 300_000, 240_000], [], True))
        for minute in range(7, 10):
            server.ingest(self.db, {"ts_ms": minute * 60_000, "sources": [{"id": "w", "value": 2, "holdings": [
                {"symbol": "SOL", "value": 1}, {"symbol": "ETH", "value": 1}]}]})
        with mock.patch.object(server, "MAX_HOLDINGS_HISTORY_ROWS", 3):
            _, cut = self.get("/v1/holdings-history?from=400000&to=600000")
        self.assertEqual((cut["polls"], [p["ts_ms"] for p in cut["points"]], cut["truncated"]),
                         ([420_000], [420_000, 420_000], True), "the poll the rows' limit cut isn't named either")

    def test_history_answers_are_built_one_at_a_time(self):
        # What takes the memory: two big answers at once had 0.9.0 killed.
        import threading
        import time as clock
        from unittest import mock
        active, most = [0], [0]
        lock = threading.Lock()

        def slow(*args, **kwargs):
            with lock:
                active[0] += 1
                most[0] = max(most[0], active[0])
            clock.sleep(0.05)
            with lock:
                active[0] -= 1
            return []

        with mock.patch.object(server, "history", slow), mock.patch.object(server, "holdings_history", slow):
            threads = [threading.Thread(target=self.get, args=(path,)) for path in
                       ["/v1/history?from=0", "/v1/history?from=1", "/v1/holdings-history?from=0", "/v1/history?from=2"]]
            for thread in threads:
                thread.start()
            self.assertEqual(self.get("/v1/portfolio")[0], 200, "the rest isn't held up")
            for thread in threads:
                thread.join()
        self.assertEqual(most[0], 1)

    def test_history_says_when_the_row_limit_cut_it_short(self):
        from unittest import mock
        status, body = self.get("/v1/history?from=0&to=9999")
        self.assertEqual((status, body["truncated"]), (200, False))
        self.assertFalse(self.get("/v1/holdings-history?from=0&to=9999")[1]["truncated"])
        server.ingest(self.db, {"ts_ms": 6000, "sources": [{"id": "a", "value": 1}]})
        with mock.patch.object(server, "MAX_HISTORY_ROWS", 1):
            status, body = self.get("/v1/history?from=0&to=9999")
        self.assertEqual((len(body["points"]), body["truncated"]), (1, True))


class PairingTests(unittest.TestCase):
    TOKEN = "p" * 40

    def decode(self, code):
        import base64
        self.assertTrue(code.startswith("atmos-finance:"))
        body = code[len("atmos-finance:"):]
        return json.loads(base64.urlsafe_b64decode(body + "=" * (-len(body) % 4)))

    def test_code_carries_the_root_address_and_token(self):
        self.assertEqual(self.decode(server.pairing_code("https://portfolio.test/", self.TOKEN)),
                         {"url": "https://portfolio.test", "token": self.TOKEN})
        self.assertEqual(self.decode(server.pairing_code("http://100.86.0.9:8787", self.TOKEN))["url"], "http://100.86.0.9:8787")
        self.assertEqual(self.decode(server.pairing_code("http://127.0.0.1:8787", self.TOKEN))["url"], "http://127.0.0.1:8787")

    def test_addresses_finance_would_refuse_are_refused_here(self):
        for url in ("http://portfolio.test", "http://192.168.1.4:8787", "https://portfolio.test/api", "ftp://portfolio.test"):
            with self.assertRaises(ValueError, msg=url):
                server.pairing_code(url, self.TOKEN)
        with self.assertRaises(ValueError):
            server.pairing_code("https://portfolio.test", "short")

    def test_default_address_comes_from_the_service_settings(self):
        self.assertEqual(server.default_url({"ATMOS_PORTFOLIO_PUBLIC_URL": "https://p.test"}), "https://p.test")
        self.assertEqual(server.default_url({"ATMOS_PORTFOLIO_HOST": "100.86.0.9", "ATMOS_PORTFOLIO_PORT": "8787"}), "http://100.86.0.9:8787")
        with self.assertRaises(ValueError):
            server.default_url({"ATMOS_PORTFOLIO_HOST": "0.0.0.0"})

    def run_cli(self, temp, *words, check=True):
        import subprocess, sys
        env_file = Path(temp) / "atmos.env"
        if not env_file.exists():
            env_file.write_text("ATMOS_PORTFOLIO_HOST=100.86.0.9\nATMOS_PORTFOLIO_PORT=8787\n")
        return subprocess.run([sys.executable, str(Path(server.__file__)), *words,
                               "--env-file", str(env_file), "--db", str(Path(temp) / "p.sqlite3")],
                              capture_output=True, text=True, check=check)

    def test_pairing_adds_a_device_with_a_token_of_its_own(self):
        with tempfile.TemporaryDirectory() as temp:
            first = self.decode(self.run_cli(temp, "pairing").stdout.strip())
            second = self.decode(self.run_cli(temp, "pairing", "--name", "phone").stdout.strip())
            db = str(Path(temp) / "p.sqlite3")
            self.assertEqual(first["url"], "http://100.86.0.9:8787")
            self.assertNotEqual(first["token"], second["token"])
            self.assertGreaterEqual(len(first["token"]), 64)
            self.assertEqual(server.device_for_token(db, first["token"]), "device 1")
            self.assertEqual(server.device_for_token(db, second["token"]), "phone")

    def test_device_commands(self):
        with tempfile.TemporaryDirectory() as temp:
            code = self.decode(self.run_cli(temp, "device", "add", "work", "laptop").stdout.strip())
            db = str(Path(temp) / "p.sqlite3")
            self.assertEqual(server.device_for_token(db, code["token"]), "work laptop")
            self.assertIn("work laptop", self.run_cli(temp, "device", "list").stdout)
            self.assertNotEqual(self.run_cli(temp, "device", "add", "Work Laptop", check=False).returncode, 0)
            self.run_cli(temp, "device", "revoke", "work", "laptop")
            self.assertIsNone(server.device_for_token(db, code["token"]))
            self.assertNotEqual(self.run_cli(temp, "device", "revoke", "work", "laptop", check=False).returncode, 0)
            self.assertNotEqual(self.run_cli(temp, "device", "rename", check=False).returncode, 0)

    def test_device_list_mentions_a_shared_token_still_set(self):
        with tempfile.TemporaryDirectory() as temp:
            (Path(temp) / "atmos.env").write_text(f"ATMOS_PORTFOLIO_HOST=127.0.0.1\nATMOS_PORTFOLIO_TOKEN={self.TOKEN}\n")
            listing = self.run_cli(temp, "device", "list").stdout
            self.assertIn("No devices paired", listing)
            self.assertIn("ATMOS_PORTFOLIO_TOKEN is set", listing)
            self.assertNotIn(self.TOKEN, listing)

    def test_db_given_on_the_command_line_wins_over_the_env_file(self):
        with tempfile.TemporaryDirectory() as temp:
            other = Path(temp) / "env-db.sqlite3"
            (Path(temp) / "atmos.env").write_text(f"ATMOS_PORTFOLIO_HOST=127.0.0.1\nATMOS_PORTFOLIO_DB={other}\n")
            self.run_cli(temp, "device", "add", "laptop")  # run_cli passes --db p.sqlite3
            self.assertEqual(len(server.list_devices(str(Path(temp) / "p.sqlite3"))), 1)
            self.assertFalse(other.exists())

    def test_a_refused_address_adds_no_device(self):
        with tempfile.TemporaryDirectory() as temp:
            result = self.run_cli(temp, "device", "add", "laptop", "--url", "http://192.168.1.4:8787", check=False)
            self.assertNotEqual(result.returncode, 0)
            self.assertEqual(server.list_devices(str(Path(temp) / "p.sqlite3")), [])


class DeviceTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.db = str(Path(self.temp.name) / "d.sqlite3")
        server.migrate(self.db)

    def tearDown(self):
        self.temp.cleanup()

    def test_only_a_hash_of_the_token_is_stored(self):
        _, token = server.add_device(self.db, "laptop")
        with sqlite3.connect(self.db) as db:
            dump = "\n".join(db.iterdump())
        self.assertNotIn(token, dump)

    def test_names_are_checked_and_unique_whatever_the_case(self):
        server.add_device(self.db, "  my   laptop ")
        self.assertEqual(server.list_devices(self.db)[0]["name"], "my laptop")
        for bad in ("", "-dash", "x" * 49, "a/b", "shared token", "MY LAPTOP"):
            with self.assertRaises(ValueError, msg=bad):
                server.add_device(self.db, bad)

    def test_last_used_is_written_at_most_once_a_minute(self):
        _, token = server.add_device(self.db, "laptop", now_ms=1)
        self.assertIsNone(server.list_devices(self.db)[0]["lastUsed"])
        server.device_for_token(self.db, token, now_ms=100_000)
        server.device_for_token(self.db, token, now_ms=130_000)
        self.assertEqual(server.list_devices(self.db)[0]["lastUsed"], 100_000)
        server.device_for_token(self.db, token, now_ms=160_000)
        self.assertEqual(server.list_devices(self.db)[0]["lastUsed"], 160_000)

    def test_unknown_and_oversized_tokens_are_nobody(self):
        server.add_device(self.db, "laptop")
        self.assertIsNone(server.device_for_token(self.db, "nope"))
        self.assertIsNone(server.device_for_token(self.db, ""))
        self.assertIsNone(server.device_for_token(self.db, "x" * 10_000))

    def test_an_older_database_gains_the_devices_table(self):
        with sqlite3.connect(self.db) as db:
            db.execute("DROP TABLE devices")
        server.migrate(self.db)
        server.add_device(self.db, "laptop")
        self.assertEqual(len(server.list_devices(self.db)), 1)
