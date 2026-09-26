import tempfile
import unittest
import base64
import struct
from pathlib import Path
from unittest.mock import patch

import collectors
import server


class CollectorTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.db = str(Path(self.temp.name) / "test.sqlite3")
        server.migrate(self.db)
        collectors._JUP_STAKE_CACHE.clear()
        collectors._PUMP_CURVE_PRICE_CACHE.clear()

    def tearDown(self):
        self.temp.cleanup()

    def test_binance_values_stables_as_cash(self):
        responses = [
            {"balances": [
                {"asset": "BTC", "free": "0.5", "locked": "0"},
                {"asset": "USDC", "free": "25", "locked": "0"},
            ]},
            [{"symbol": "BTCUSDT", "price": "60000"}],
        ]
        with patch.object(collectors, "_request", side_effect=responses):
            source = collectors.collect_binance({"api_key": "key", "api_secret": "secret"})
        self.assertEqual(source["value"], 30025)
        self.assertEqual({h["symbol"]: h["kind"] for h in source["holdings"]},
                         {"BTC": "invested", "USDC": "cash"})

    def test_binance_holdings_carry_quantity_and_price(self):
        responses = [
            {"balances": [{"asset": "BTC", "free": "0.5", "locked": "0"}]},
            [{"symbol": "BTCUSDT", "price": "60000"}],
        ]
        with patch.object(collectors, "_request", side_effect=responses):
            source = collectors.collect_binance({"api_key": "key", "api_secret": "secret"})
        btc = next(h for h in source["holdings"] if h["symbol"] == "BTC")
        self.assertEqual(btc["quantity"], 0.5)
        self.assertEqual(btc["price"], 60000)
        self.assertEqual(btc["value"], 30000)

    def test_manual_monero_never_needs_wallet_credentials(self):
        with patch.object(collectors, "_coingecko_price", return_value=150) as price:
            source = collectors.collect_monero({"amount": 2.5})
        self.assertEqual(source["value"], 375)
        self.assertEqual(source["error_count"], 0)
        price.assert_called_once_with("monero")

    def test_coingecko_price_uses_monero_id(self):
        with patch.object(collectors, "_request", return_value={"monero": {"usd": 175}}) as request:
            self.assertEqual(collectors._coingecko_price("monero"), 175)
        url = request.call_args.args[0]
        self.assertIn("api.coingecko.com/api/v3/simple/price", url)
        self.assertIn("ids=monero", url)

    def test_bsc_reads_native_bnb_and_usdt_directly(self):
        one_bnb = hex(10 ** 18)
        twenty_five_usdt = hex(25 * 10 ** collectors.BSC_USDT_DECIMALS)
        with patch.object(collectors, "_asset_price", return_value=600), \
             patch.object(collectors, "_bsc_rpc", side_effect=[one_bnb, twenty_five_usdt]) as rpc:
            source = collectors.collect_bsc({"addresses": ["0x" + "ab" * 20]})
        self.assertEqual(source["value"], 625)
        self.assertEqual({item["symbol"]: item["kind"] for item in source["holdings"]}, {
            "BNB": "invested", "USDT": "cash",
        })
        bnb = next(h for h in source["holdings"] if h["symbol"] == "BNB")
        usdt = next(h for h in source["holdings"] if h["symbol"] == "USDT")
        self.assertEqual(bnb["quantity"], 1.0)
        self.assertEqual(usdt["quantity"], 25.0)
        self.assertEqual(usdt["price"], 1.0)
        self.assertEqual(rpc.call_args_list[0].args[0], "eth_getBalance")
        self.assertEqual(rpc.call_args_list[1].args[0], "eth_call")

    def test_solana_fetches_staked_and_unstaking_jup_without_a_key(self):
        def request(url, **kwargs):
            if "/price/v3?" in url:
                return {collectors.JUP_MINT: {"usdPrice": 2}}
            if "/tokens/v2/search?" in url:
                return [{"id": collectors.JUP_MINT, "symbol": "JUP"}]
            if "/portfolio/v1/staked-jup/" in url:
                self.assertEqual(kwargs.get("headers"), {})
                return {"stakedAmount": "10", "unstaking": [{"amount": "2"}, {"amount": "3"}]}
            self.fail(f"unexpected URL: {url}")

        rpc_results = [
            {"value": 0},
            {"value": []},
            {"value": []},
        ]
        with patch.object(collectors, "_asset_price", return_value=100), \
             patch.object(collectors, "_sol_rpc", side_effect=rpc_results), \
             patch.object(collectors, "_request", side_effect=request):
            source = collectors.collect_solana({"addresses": ["wallet"]})

        self.assertEqual(source["error_count"], 0)
        self.assertEqual({item["symbol"]: item["value"] for item in source["holdings"]}, {
            "JUP (staked)": 30,
        })
        staked = next(h for h in source["holdings"] if h["symbol"] == "JUP (staked)")
        self.assertEqual(staked["quantity"], 15)
        self.assertEqual(staked["price"], 2)

    def test_solana_batches_jupiter_lookups_across_wallets(self):
        calls = []

        def request(url, **kwargs):
            calls.append(url)
            if "/price/v3?" in url:
                return {collectors.JUP_MINT: {"usdPrice": 2}}
            if "/tokens/v2/search?" in url:
                return [{"id": collectors.JUP_MINT, "symbol": "JUP"}]
            if "/portfolio/v1/staked-jup/" in url:
                return {"stakedAmount": "0", "unstaking": []}
            self.fail(f"unexpected URL: {url}")

        rpc_results = []
        for _ in range(3):
            rpc_results.extend(({"value": 0}, {"value": []}, {"value": []}))
        with patch.object(collectors, "_asset_price", return_value=100), \
             patch.object(collectors, "_sol_rpc", side_effect=rpc_results), \
             patch.object(collectors, "_request", side_effect=request), \
             patch.object(collectors.time, "sleep") as sleep:
            source = collectors.collect_solana({"addresses": ["one", "two", "three"]})

        self.assertEqual(source["error_count"], 0)
        self.assertEqual(sum("/price/v3?" in url for url in calls), 1)
        self.assertEqual(sum("/tokens/v2/search?" in url for url in calls), 1)
        self.assertEqual(sum("/portfolio/v1/staked-jup/" in url for url in calls), 3)
        self.assertEqual(sleep.call_count, 2)

    def test_solana_uses_pump_curve_when_jupiter_has_no_price(self):
        pump_mint = collectors.PUMP_PROGRAM

        def request(url, **kwargs):
            if "/price/v3?" in url:
                return {}
            if "/tokens/v2/search?" in url:
                return [{"id": pump_mint, "symbol": "TINY"}]
            if "/portfolio/v1/staked-jup/" in url:
                return {"stakedAmount": "0", "unstaking": []}
            self.fail(f"unexpected URL: {url}")

        token_account = {"value": [{"account": {"data": {"parsed": {"info": {
            "mint": pump_mint,
            "tokenAmount": {"uiAmount": 1000, "decimals": 6},
        }}}}}]}
        rpc_results = [{"value": 0}, token_account, {"value": []}]
        with patch.object(collectors, "_asset_price", return_value=100), \
             patch.object(collectors, "_sol_rpc", side_effect=rpc_results), \
             patch.object(collectors, "_pump_curve_prices", return_value={pump_mint: 0.0001}) as pump, \
             patch.object(collectors, "_request", side_effect=request):
            source = collectors.collect_solana({"addresses": ["wallet"]})

        tiny = next(item for item in source["holdings"] if item["symbol"] == "TINY")
        self.assertAlmostEqual(tiny["value"], 0.1)
        pump.assert_called_once()
        self.assertEqual(pump.call_args.args[1][pump_mint], 6)

    def test_pump_curve_prices_incomplete_sol_pair_from_reserves(self):
        mint = collectors.PUMP_PROGRAM
        curve = (
            collectors.PUMP_BONDING_CURVE_DISCRIMINATOR
            + struct.pack("<QQQQQ", 1_000_000 * 10 ** 6, 30 * 10 ** 9, 1, 1, 1_000_000 * 10 ** 6)
            + b"\0"  # incomplete
            + b"\0" * 32  # creator
            + b"\0\0"  # mayhem / cashback
            + b"\0" * 32  # native SOL quote marker
        )
        account = {"owner": collectors.PUMP_PROGRAM, "data": [base64.b64encode(curve).decode(), "base64"]}
        with patch.object(collectors, "_sol_rpc", return_value={"value": [account]}) as rpc:
            prices = collectors._pump_curve_prices([mint], {mint: 6}, 100)

        self.assertAlmostEqual(prices[mint], 0.003)
        self.assertEqual(rpc.call_args.args[0], "getMultipleAccounts")
        self.assertEqual(len(rpc.call_args.args[1][0]), 1)

    def test_pump_curve_ignores_completed_and_unknown_quote_pairs(self):
        prefix = collectors.PUMP_BONDING_CURVE_DISCRIMINATOR + struct.pack(
            "<QQQQQ", 1_000_000, 30_000_000_000, 1, 1, 1_000_000,
        )
        completed = prefix + b"\1"
        unknown_quote = prefix + b"\0" + b"\0" * 34 + b"\1" + b"\0" * 31
        self.assertEqual(collectors._pump_curve_price(completed, 6, 100), 0)
        self.assertEqual(collectors._pump_curve_price(unknown_quote, 6, 100), 0)

    def test_pump_curve_prices_usdc_pair_in_dollars(self):
        usdc = collectors._base58_decode("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v")
        curve = (
            collectors.PUMP_BONDING_CURVE_DISCRIMINATOR
            # 1,000,000 tokens (6 decimals) against 4,000 USDC (6 decimals)
            + struct.pack("<QQQQQ", 1_000_000 * 10 ** 6, 4_000 * 10 ** 6, 1, 1, 1_000_000 * 10 ** 6)
            + b"\0" + b"\0" * 32 + b"\0\0" + usdc
        )
        # $0.004 a token, whatever SOL is worth.
        self.assertAlmostEqual(collectors._pump_curve_price(curve, 6, 100), 0.004)
        self.assertAlmostEqual(collectors._pump_curve_price(curve, 6, 250), 0.004)

    def test_jupiter_staking_response_is_cached_for_five_minutes(self):
        response = {"stakedAmount": "4", "unstaking": [{"amount": "1"}]}
        with patch.object(collectors, "_request", return_value=response) as request, \
             patch.object(collectors.time, "monotonic", side_effect=[100, 399]):
            self.assertEqual(collectors._jupiter_staked_amount("wallet"), (5, False))
            self.assertEqual(collectors._jupiter_staked_amount("wallet"), (5, False))
        request.assert_called_once()

    def test_jupiter_failure_preserves_last_confirmed_staked_position(self):
        response = {"stakedAmount": "4", "unstaking": [{"amount": "1"}]}
        with patch.object(collectors, "_request", side_effect=[response, collectors.CollectorError("temporary")]), \
             patch.object(collectors.time, "monotonic", side_effect=[100, 401]):
            self.assertEqual(collectors._jupiter_staked_amount("wallet"), (5, False))
            self.assertEqual(collectors._jupiter_staked_amount("wallet"), (5, True))

    def test_jupiter_lock_reads_exact_on_chain_vault_balance(self):
        escrow = collectors._base58_encode(bytes(range(1, 33)))
        mint_bytes = bytes(range(33, 65))
        mint = collectors._base58_encode(mint_bytes)
        lock_data = bytearray(296)
        lock_data[:8] = collectors.JUP_LOCK_DISCRIMINATOR
        lock_data[40:72] = mint_bytes
        lock_data[139] = 1
        struct.pack_into("<5Q", lock_data, 144, 1_800_000_000, 60, 0, 1_000_000, 10)
        mint_data = bytearray(82)
        mint_data[44] = 6
        vault_data = bytearray(165)
        struct.pack_into("<Q", vault_data, 64, 9_999_996)
        responses = [
            {"value": [{"owner": collectors.JUP_LOCK_PROGRAM, "data": [base64.b64encode(lock_data).decode(), "base64"]}]},
            {"value": [{"data": [base64.b64encode(vault_data).decode(), "base64"]}]},
            {"value": [{"data": [base64.b64encode(mint_data).decode(), "base64"]}]},
        ]
        with patch.object(collectors, "_sol_rpc", side_effect=responses):
            positions = collectors._jupiter_lock_positions({"jupiter_locks": [escrow]})
        self.assertEqual(len(positions), 1)
        self.assertEqual(positions[0]["mint"], mint)
        self.assertAlmostEqual(positions[0]["quantity"], 9.999996)
        self.assertEqual(positions[0]["vesting_end"], 1_800_000_600)

    def test_failed_source_keeps_previous_value(self):
        server.ingest(self.db, {"sources": [{
            "id": "cardano-wallet", "label": "ADA", "value": 42,
            "holdings": [{"id": "stake1x:native:ADA", "symbol": "ADA", "value": 42}],
        }]})
        config = {"sources": {"cardano-wallet": {"enabled": True, "addresses": ["stake1x"]}}}
        with patch.dict(collectors.COLLECTORS, {
            "cardano-wallet": lambda _: (_ for _ in ()).throw(collectors.CollectorError("no")),
        }):
            frame = collectors.collect_once(config, self.db)
        self.assertEqual(frame["total"], 42)
        self.assertEqual(frame["error_count"], 1)
        self.assertEqual(frame["sources"][0]["holdings"][0]["id"], "stake1x:native:ADA")

    def test_config_omits_disabled_and_unknown_sources(self):
        config = {"sources": {
            "binance-spot": {"enabled": True},
            "litecoin-wallet": {"enabled": True},
            "trading212": {"enabled": True},
            "monero-wallet": {"enabled": False},
        }}
        self.assertEqual(list(collectors.configured_sources(config)), ["binance-spot"])

    def test_empty_configuration_does_not_write_zero_history(self):
        result = collectors.collect_once({"sources": {}}, self.db)
        self.assertTrue(result["skipped"])
        self.assertEqual(server.latest(self.db)["timestamp"], None)

    def test_load_config_rejects_malformed_document(self):
        path = Path(self.temp.name) / "bad.json"
        path.write_text("[]", encoding="utf-8")
        with self.assertRaises(collectors.CollectorError):
            collectors.load_config(str(path))


if __name__ == "__main__":
    unittest.main()
