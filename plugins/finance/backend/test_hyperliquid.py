"""Hyperliquid: an outage of its price or token lists counts as an error,
so the collector keeps the last snapshot instead of taking the holdings
as worthless (R8)."""

import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import collectors
import server
from connectors import hyperliquid as hl
from connectors.shared import CollectorError


def info_with(prices_up=True, meta_up=True):
    def info(payload):
        kind = payload["type"]
        if kind == "spotMeta":
            if not meta_up:
                raise CollectorError("spotMeta unavailable")
            return {"tokens": [{"index": 1, "name": "HYPE"}], "universe": [{"index": 7, "tokens": [1, 0]}]}
        if kind == "allMids":
            if not prices_up:
                raise CollectorError("allMids unavailable")
            return {"@7": "50"}
        if kind == "spotClearinghouseState":
            return {"balances": [{"coin": "HYPE", "total": "2"}]}
        if kind == "borrowLendUserState":
            return {"tokenToState": []}
        if kind == "clearinghouseState":
            return {"assetPositions": []}
        return {}
    return info


class HyperliquidOutageTests(unittest.TestCase):
    CONFIG = {"sources": {"hyperliquid-wallet": {"addresses": ["0xhl"]}}}

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.db = str(Path(self.temp.name) / "hl.sqlite3")
        server.migrate(self.db)
        hl._SPOT_META_CACHE = None
        hl._SPOT_META_READ_AT = 0.0

    def tearDown(self):
        hl._SPOT_META_CACHE = None
        hl._SPOT_META_READ_AT = 0.0
        self.temp.cleanup()

    def collect(self, **state):
        with patch.object(hl, "_info", side_effect=info_with(**state)), patch.object(hl, "_funding_rates", return_value={}):
            return collectors.collect_once(self.CONFIG, self.db)

    def test_a_price_outage_keeps_the_last_snapshot(self):
        self.assertEqual(self.collect()["sources"][0]["value"], 100)
        frame = self.collect(prices_up=False)
        source = frame["sources"][0]
        self.assertEqual(source["value"], 100, "not $0: the last snapshot stands")
        self.assertGreater(source["error_count"], 0)
        self.assertEqual(server.latest(self.db)["holdings"][0]["value"], 100)

    def test_a_failed_token_list_is_asked_for_again(self):
        frame = self.collect(meta_up=False)
        self.assertGreater(frame["sources"][0]["error_count"], 0, "counted, not taken for an empty list")
        self.assertEqual(self.collect()["sources"][0]["value"], 100, "the next poll reads it again and prices HYPE")

    def collect_with(self, info):
        with patch.object(hl, "_info", side_effect=info), patch.object(hl, "_funding_rates", return_value={}):
            return collectors.collect_once(self.CONFIG, self.db)

    def test_an_empty_price_list_is_an_outage_too(self):
        # Review of R8: allMids answering {} read as no prices, no error.
        normal = info_with()
        self.assertEqual(self.collect_with(normal)["sources"][0]["value"], 100)
        frame = self.collect_with(lambda payload: {} if payload["type"] == "allMids" else normal(payload))
        self.assertEqual(frame["sources"][0]["value"], 100, "the last snapshot stands")
        self.assertGreater(frame["sources"][0]["error_count"], 0)

    def test_an_outage_needs_something_to_price(self):
        # Review of R8: only USDC held, so nothing needed a price; the new
        # balance is taken, not the last one kept.
        def usdc_only(amount):
            def info(payload):
                if payload["type"] == "spotClearinghouseState":
                    return {"balances": [{"coin": "USDC", "total": str(amount)}]}
                return info_with(prices_up=False, meta_up=False)(payload)
            return info
        self.collect_with(usdc_only(1000))
        frame = self.collect_with(usdc_only(1500))
        self.assertEqual(frame["sources"][0]["value"], 1500)
        self.assertEqual(frame["sources"][0]["error_count"], 0)

    def test_a_token_listed_since_the_list_was_read_is_priced(self):
        # Review of R8: the token list was read once per process, so a token
        # listed later read as $0 for good.
        normal = info_with()
        self.collect_with(normal)
        hl._SPOT_META_READ_AT -= hl.SPOT_META_REFRESH_S
        def listed_since(payload):
            kind = payload["type"]
            if kind == "spotMeta":
                return {"tokens": [{"index": 1, "name": "HYPE"}, {"index": 2, "name": "NEWT"}],
                        "universe": [{"index": 7, "tokens": [1, 0]}, {"index": 8, "tokens": [2, 0]}]}
            if kind == "allMids":
                return {"@7": "50", "@8": "3"}
            if kind == "spotClearinghouseState":
                return {"balances": [{"coin": "HYPE", "total": "2"}, {"coin": "NEWT", "total": "10"}]}
            return normal(payload)
        self.assertEqual(self.collect_with(listed_since)["sources"][0]["value"], 130)

    def test_a_token_without_a_market_does_not_freeze_the_account(self):
        # Both lists read: a token that has no price is worth nothing here,
        # not an outage (which would keep the last snapshot for good).
        normal = info_with()
        def unpriced(payload):
            if payload["type"] == "spotClearinghouseState":
                return {"balances": [{"coin": "HYPE", "total": "2"}, {"coin": "JUNK", "total": "5"}]}
            return normal(payload)
        frame = self.collect_with(unpriced)
        self.assertEqual(frame["sources"][0]["error_count"], 0)
        self.assertEqual(frame["sources"][0]["value"], 100)


if __name__ == "__main__":
    unittest.main()
