"""The connector registry: discovery, how a configured source finds its
connector, and what is generated from the declarations."""

import dataclasses
import json
import types
import unittest
from pathlib import Path
from unittest.mock import patch

import collectors
import connectors
from connectors.shared import CollectorError, collected, holding

HERE = Path(__file__).parent
LEGACY_IDS = {
    "aptos-wallet", "arbitrum-wallet", "binance-spot", "bsc-wallet", "cardano-wallet",
    "hyperliquid-wallet", "inj-wallet", "monero-wallet", "solana-wallet",
}


class RegistryTests(unittest.TestCase):
    def test_every_folder_is_a_connector_and_keeps_its_source_id(self):
        folders = {path.name for path in (HERE / "connectors").iterdir()
                   if path.is_dir() and (path / "__init__.py").exists() and path.name != "shared"}
        self.assertEqual(set(connectors.CONNECTORS), folders)
        # Stored history, hidden holdings and ticker toggles in Finance are
        # keyed by these ids: they must keep working.
        self.assertEqual(set(connectors.BY_LEGACY_ID), LEGACY_IDS)

    def test_a_source_finds_its_connector(self):
        find = connectors.connector_for
        self.assertEqual(find("solana-wallet", {}).type, "solana")
        self.assertEqual(find("binance:work", {}).type, "binance")
        self.assertEqual(find("binance", {}).type, "binance")
        self.assertEqual(find("my-exchange", {"type": "binance"}).type, "binance")
        self.assertIsNone(find("litecoin-wallet", {}))
        self.assertIsNone(find("solana-wallet", {"type": "litecoin"}), "an explicit type wins")

    def test_the_runner_names_the_source_not_the_connector(self):
        stub = dataclasses.replace(connectors.CONNECTORS["binance"], collect=lambda config: collected([holding("BTC", 1, 100)]))
        with patch.dict(connectors.CONNECTORS, {"binance": stub}), patch.dict(connectors.BY_LEGACY_ID, {"binance-spot": stub}):
            work = connectors.collect("binance:work", {"label": "Work"})
            plain = connectors.collect("binance-spot", {})
        self.assertEqual((work["id"], work["label"]), ("binance:work", "Work"))
        self.assertEqual((plain["id"], plain["label"]), ("binance-spot", "Binance"))
        self.assertEqual(work["holdings"][0]["meta"]["dapp"], "Binance", "dimensions come from the declaration")

    def test_several_sources_of_one_type_are_collected(self):
        config = {"sources": {
            "binance-spot": {"enabled": True},
            "binance:work": {"enabled": True},
            "work-wallets": {"type": "solana", "enabled": True},
            "litecoin-wallet": {"enabled": True},
        }}
        self.assertEqual(sorted(collectors.configured_sources(config)), ["binance-spot", "binance:work", "work-wallets"])

    def test_unknown_type_is_refused(self):
        with self.assertRaises(CollectorError):
            connectors.collect("mystery", {})

    def test_a_declaration_is_checked(self):
        def module(**declared):
            fake = types.ModuleType("connectors.fake")
            fake.CONNECTOR = declared
            fake.collect = lambda config: collected([])
            return fake
        with self.assertRaises(RuntimeError):
            connectors._load(module(type="Bad Type"))
        with self.assertRaises(RuntimeError):
            connectors._load(module(type="fake", fields=[{"key": "x", "kind": "colour", "prompt": "X"}]))
        loaded = connectors._load(module(type="fake"))
        self.assertEqual((loaded.default_id, loaded.label), ("fake", "fake"))

    def test_the_example_configuration_is_generated(self):
        on_disk = json.loads((HERE / "sources.example.json").read_text(encoding="utf-8"))
        self.assertEqual(on_disk, connectors.example_config(),
                         "regenerate it: python3 collectors.py example-config > sources.example.json")
        for values in on_disk["sources"].values():
            self.assertFalse(values["enabled"])

    def test_declarations_are_described_without_code(self):
        described = connectors.describe()
        self.assertEqual({item["type"] for item in described}, set(connectors.CONNECTORS))
        json.dumps(described)  # plain data, for setup tools and forms


class ConfigureTests(unittest.TestCase):
    def answers(self, replies):
        asked = []

        def ask(prompt, secret=True):
            asked.append(prompt)
            for fragment, reply in replies.items():
                if prompt.startswith(fragment):
                    return reply
            return ""
        return ask, asked

    def test_answered_sources_are_enabled_and_blank_ones_skipped(self):
        ask, asked = self.answers({
            "Solana addresses": " one, two;one ",
            "Jupiter Lock escrow": "escrow",
            "Binance read-only API key": "key",
            "Binance read-only API secret": "secret",
            "Manual XMR amount": "1.25",
        })
        config = connectors.build_config(ask)
        sources = config["sources"]
        self.assertEqual(sources["solana-wallet"]["addresses"], ["one", "two"])
        self.assertEqual(sources["solana-wallet"]["jupiter_locks"], ["escrow"])
        self.assertEqual(sources["solana-wallet"]["jupiter_api_key"], "")
        self.assertTrue(sources["solana-wallet"]["enabled"])
        self.assertEqual(sources["binance-spot"]["api_secret"], "secret")
        self.assertEqual(sources["monero-wallet"]["amount"], 1.25)
        self.assertFalse(sources["cardano-wallet"]["enabled"])
        # A skipped source's other settings aren't asked for.
        self.assertFalse(any(prompt.startswith("Jupiter") for prompt in asked[:asked.index(
            next(p for p in asked if p.startswith("Solana")))]))
        self.assertIn("Cardano addresses, separated by commas (blank to disable)", asked)

    def test_more_accounts_of_one_kind(self):
        ask, asked = self.answers({
            "Binance read-only API key": "main-key", "Binance read-only API secret": "main-secret",
            "Another Binance Spot account": None,  # filled in below
            "Work: Binance read-only API key": "work-key", "Work: Binance read-only API secret": "work-secret",
            "Work!: Binance read-only API key": "", 
        })
        names = iter(["Work", "Work!", ""])
        def answer(prompt, secret=True):
            if prompt.startswith("Another Binance Spot account"):
                self.assertFalse(secret, "an account's name isn't masked")
                return next(names)
            return ask(prompt, secret)
        sources = connectors.build_config(answer)["sources"]
        self.assertEqual(sources["binance-spot"]["api_key"], "main-key")
        self.assertEqual(sources["binance:work"], {
            "type": "binance", "enabled": True, "api_key": "work-key", "api_secret": "work-secret", "label": "Work",
        })
        self.assertNotIn("binance:work-2", sources, "an account left blank is skipped")
        self.assertIn("Work: Binance read-only API key (blank to skip)", asked)
        self.assertFalse(any(p.startswith("Another Cardano") for p in asked), "only offered for a kind in use")
        self.assertEqual(sorted(collectors.configured_sources({"sources": sources})), ["binance-spot", "binance:work"])

    def test_a_missing_second_credential_is_an_error(self):
        ask, _ = self.answers({"Binance read-only API key": "key"})
        with self.assertRaisesRegex(ValueError, "secret"):
            connectors.build_config(ask)

    def test_amounts_must_be_numbers(self):
        for reply in ("-1", "lots", "inf", "nan"):
            ask, _ = self.answers({"Manual XMR amount": reply})
            with self.assertRaises(ValueError, msg=reply):
                connectors.build_config(ask)


if __name__ == "__main__":
    unittest.main()
