"""Groups: balances of a source included or left out as a whole, whichever
connector sets them, and rows stored before 0.8 still grouped."""

import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import collectors
import connectors
import server
from connectors import hyperliquid as hl


class GroupTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.db = str(Path(self.temp.name) / "groups.sqlite3")
        server.migrate(self.db)

    def tearDown(self):
        self.temp.cleanup()

    def test_any_source_can_group_holdings(self):
        server.ingest(self.db, {"ts_ms": 1000, "sources": [{
            "id": "exchange:main", "value": 100,
            "holdings": [
                {"id": "margin", "symbol": "USDT", "value": 60, "kind": "cash",
                 "meta": {"instrument": "perp-cash", "group": "futures"}},
                {"id": "position", "symbol": "ETH Perp", "value": 10, "meta": {"instrument": "perp", "group": "futures"}},
                {"id": "spot", "symbol": "ETH", "value": 30, "meta": {"instrument": "spot"}},
            ],
        }]})
        point = server.history(self.db, 0, 2000, "raw", set(), set(), {("exchange:main", "futures")})[0]
        self.assertEqual((point["v"], point["spot"], point["perp"]), (30, 30, 0))
        # A grouped holding isn't left out on its own.
        alone = server.history(self.db, 0, 2000, "raw", {("exchange:main", "position")})[0]
        self.assertEqual(alone["v"], 100)
        self.assertEqual(server.latest(self.db)["holdings"][0]["meta"]["group"], "futures")

    def test_a_group_id_is_checked_on_the_way_in(self):
        frame = server.clean_frame({"sources": [{"id": "x", "value": 1, "holdings": [
            {"id": "h", "symbol": "A", "value": 1, "meta": {"group": "Not A Group!", "chain": "Z"}},
        ]}]})
        self.assertEqual(json.loads(frame["sources"][0]["holdings"][0]["meta"]), {"chain": "Z"})

    def test_rows_stored_before_groups_are_still_grouped(self):
        rows = [
            ("cash", "USDC", "cash", 50, json.dumps({"instrument": "perp-cash"})),
            ("position", "BTC Perp", "invested", 30, json.dumps({"instrument": "perp"})),
            ("earn", "USDC Earn", "cash", 40, json.dumps({"instrument": "perp-cash", "account": "earn"})),
            ("idle", "USDT", "cash", 5, None),  # from before instruments
        ]
        with server.connect(self.db) as db:
            db.execute("INSERT INTO portfolio_samples (ts_ms,total,invested,cash,currency,error_count,spot,perp) "
                       "VALUES (1000,125,30,95,'USD',0,0,125)")
            for holding_id, symbol, kind, value, meta in rows:
                db.execute("INSERT INTO holdings_history (ts_ms,source_id,holding_id,symbol,kind,quantity,price,value,currency,meta) "
                           "VALUES (1000,'hyperliquid-wallet',?,?,?,?,1,?,'USD',?)", (holding_id, symbol, kind, value, value, meta))
        without_perp = server.history(self.db, 0, 2000, "raw", set(), set(), {("hyperliquid-wallet", "perp")})[0]
        self.assertEqual((without_perp["v"], without_perp["perp"]), (40, 40))
        without_earn = server.history(self.db, 0, 2000, "raw", set(), set(), {("hyperliquid-wallet", "earn")})[0]
        self.assertEqual(without_earn["v"], 85)
        groups = {row["holding_id"]: row["meta"]["group"] for row in server.holdings_history(self.db, 0, 2000)}
        self.assertEqual(groups, {"cash": "perp", "position": "perp", "earn": "earn", "idle": "perp"})

    def test_hyperliquid_says_its_groups(self):
        def info(payload):
            if payload["type"] == "spotClearinghouseState":
                return {"balances": [{"coin": "USDC", "total": "100"}, {"coin": "HYPE", "total": "2"}]}
            if payload["type"] == "borrowLendUserState":
                return {"tokenToState": [[0, {"supply": {"basis": "10", "value": "10"}}]]}
            if payload["type"] == "clearinghouseState":
                return {"assetPositions": [{"position": {"coin": "BTC", "szi": "0.01", "positionValue": "600",
                                                         "marginUsed": "60", "unrealizedPnl": "0"}}]}
            return {}
        spot_meta = {"tokens": [{"index": 0, "name": "USDC"}], "universe": []}
        with patch.object(hl, "_spot_meta", return_value=spot_meta), patch.object(hl, "_info", side_effect=info), \
             patch.object(hl, "_funding_rates", return_value={}), patch.object(hl, "_funding_24h", return_value={}), \
             patch.object(hl, "_fees_24h", return_value={}), patch.object(hl, "_spot_price", return_value=1):
            source = connectors.collect("hyperliquid-wallet", {"addresses": ["0xhl"]})
        groups = {item["symbol"]: (item["meta"] or {}).get("group") for item in source["holdings"]}
        self.assertEqual(groups, {"USDC": "perp", "BTC Perp": "perp", "USDC Earn": "earn", "HYPE": None})
        declared = {item["id"] for item in connectors.CONNECTORS["hyperliquid"].groups}
        self.assertLessEqual({group for group in groups.values() if group}, declared)

    def test_two_accounts_of_one_kind_are_grouped_apart(self):
        def info(payload):
            usdc = {"0xmain": "100", "0xalt": "7"}[payload.get("user", "0xmain")]
            if payload["type"] == "spotClearinghouseState": return {"balances": [{"coin": "USDC", "total": usdc}]}
            if payload["type"] == "borrowLendUserState": return {"tokenToState": []}
            if payload["type"] == "clearinghouseState": return {"assetPositions": []}
            return {}
        config = {"sources": {
            "hyperliquid-wallet": {"addresses": ["0xmain"]},
            "hyperliquid:alt": {"type": "hyperliquid", "label": "Alt", "addresses": ["0xalt"]},
        }}
        with patch.object(hl, "_spot_meta", return_value={}), patch.object(hl, "_info", side_effect=info), \
             patch.object(hl, "_funding_rates", return_value={}), patch.object(hl, "_spot_price", return_value=1):
            frame = collectors.collect_once(config, self.db)
        self.assertEqual({source["id"]: source["perp"] for source in frame["sources"]},
                         {"hyperliquid-wallet": 100, "hyperliquid:alt": 7})
        labels = {row["source_id"]: row["label"] for row in server.latest(self.db)["sources"]}
        self.assertEqual(labels, {"hyperliquid-wallet": "Hyperliquid", "hyperliquid:alt": "Alt"})
        ts = frame["ts_ms"]
        point = server.history(self.db, ts, ts, "raw", set(), set(), {("hyperliquid:alt", "perp")})[0]
        self.assertEqual((point["v"], point["perp"]), (100, 100))


if __name__ == "__main__":
    unittest.main()
