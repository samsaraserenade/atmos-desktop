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
        self.assertEqual(body, {"name": "atmos-portfolio", "version": server.VERSION, "apiVersion": 1, "sources": 2, "lastUpdate": 5000,
                                "retention": {"holdingsRawDays": 30, "holdingsHourlyDays": 365}})

    def test_bad_times_are_a_400_not_a_dropped_connection(self):
        status, body = self.get("/v1/history?from=yesterday")
        self.assertEqual(status, 400)
        self.assertIn("from", body["error"])
        self.assertEqual(self.get("/v1/holdings-history?to=soon")[0], 400)
        self.assertEqual(self.get("/v1/history?from=0&to=9999")[0], 200)

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

    def test_pairing_command_reads_the_env_file(self):
        import subprocess, sys
        with tempfile.TemporaryDirectory() as temp:
            env_file = Path(temp) / "atmos.env"
            env_file.write_text(f"ATMOS_PORTFOLIO_HOST=100.86.0.9\nATMOS_PORTFOLIO_PORT=8787\nATMOS_PORTFOLIO_TOKEN={self.TOKEN}\n")
            result = subprocess.run([sys.executable, str(Path(server.__file__)), "pairing", "--env-file", str(env_file)],
                                    capture_output=True, text=True, check=True)
        self.assertEqual(self.decode(result.stdout.strip()), {"url": "http://100.86.0.9:8787", "token": self.TOKEN})
