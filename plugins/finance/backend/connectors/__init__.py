"""Finance's connectors: one folder each under connectors/, found at start-up.

A connector is a package with two things in its __init__.py:

    CONNECTOR = {
        "type": "solana",              # what it is; `type` in a source's config
        "name": "Solana",              # for people: setup prompts, lists
        "label": "Solana",             # the source's name in Finance (at most 12 characters)
        "legacy_id": "solana-wallet",  # optional: the source id configs used before types
        "fields": [                    # its configuration, in the order to ask for it
            {"key": "addresses", "kind": "addresses", "required": True, "prompt": "Solana addresses"},
            {"key": "jupiter_api_key", "kind": "secret", "prompt": "Jupiter API key"},
        ],
        "dimensions": {...},           # defaults for each holding's meta (dapp, chain, ...)
        "groups": [                    # optional: balances included or left out as a whole
            {"id": "perp", "label": "Perp"},
        ],
    }

    def collect(config) -> dict        # shared.collected(holdings, errors, wallet_addresses)

A connector never names its source: the runner does, from the
configuration, so one connector can serve several sources (two Binance
accounts, say). Field kinds are "addresses" (a list), "secret" (a string
kept out of logs) and "number". Everything shared (network access, prices,
EVM and holding helpers) is in connectors/shared/.

Groups: a holding whose meta has "group" belongs to that balance of its
source (Hyperliquid's "perp" and "earn"). Finance includes or leaves it out
with its group, not on its own, so a connector groups holdings that only
make sense together (collateral and the positions it backs). Declare each
group a connector uses under "groups".

A source in the configuration names its connector with "type". Without
one, a connector's legacy id (the ids configs have always used, like
"solana-wallet") or an id of the form "<type>" or "<type>:<name>" (like
"binance:work") says which.
"""

from __future__ import annotations

import importlib
import math
import pkgutil
import re
from dataclasses import dataclass, field
from types import ModuleType
from typing import Any, Callable

from .shared import CollectorError, build_source

FIELD_KINDS = {"addresses": [], "secret": "", "number": 0}
_TYPE = re.compile(r"^[a-z0-9][a-z0-9-]*$")
_GROUP = re.compile(r"^[a-z0-9][a-z0-9-]{0,31}$")  # server.py accepts the same in excludeGroup


@dataclass(frozen=True)
class Connector:
    type: str
    name: str
    label: str
    legacy_id: str | None
    fields: tuple[dict[str, Any], ...]
    dimensions: dict[str, Any]
    groups: tuple[dict[str, str], ...]
    collect: Callable[[dict[str, Any]], dict[str, Any]] = field(repr=False)
    module: ModuleType = field(repr=False)

    @property
    def default_id(self) -> str:
        """The source id a configuration uses when it has one source of this type."""
        return self.legacy_id or self.type

    def describe(self) -> dict[str, Any]:
        return {
            "type": self.type, "name": self.name, "label": self.label,
            **({"legacyId": self.legacy_id} if self.legacy_id else {}),
            "fields": [dict(item) for item in self.fields],
            "dimensions": dict(self.dimensions),
            "groups": [dict(item) for item in self.groups],
        }


def _load(module: ModuleType) -> Connector:
    declared = getattr(module, "CONNECTOR", None)
    collect = getattr(module, "collect", None)
    where = module.__name__
    if not isinstance(declared, dict) or not callable(collect):
        raise RuntimeError(f"{where}: a connector needs CONNECTOR and collect()")
    kind = str(declared.get("type") or "")
    if not _TYPE.match(kind):
        raise RuntimeError(f"{where}: type must be lower-case letters, digits and -")
    if len(str(declared.get("label") or kind)) > 12:
        raise RuntimeError(f"{where}: label is at most 12 characters (Finance shows no more)")
    fields = tuple(declared.get("fields") or ())
    for item in fields:
        if not item.get("key") or item.get("kind") not in FIELD_KINDS or not item.get("prompt"):
            raise RuntimeError(f"{where}: every field needs key, kind ({', '.join(FIELD_KINDS)}) and prompt")
    groups = tuple(declared.get("groups") or ())
    for item in groups:
        if not _GROUP.match(str(item.get("id") or "")) or not item.get("label"):
            raise RuntimeError(f"{where}: every group needs an id (lower-case letters, digits and -) and a label")
    return Connector(
        type=kind,
        name=str(declared.get("name") or kind),
        label=str(declared.get("label") or kind),
        legacy_id=declared.get("legacy_id"),
        fields=fields,
        dimensions=dict(declared.get("dimensions") or {}),
        groups=groups,
        collect=collect,
        module=module,
    )


def _discover() -> dict[str, Connector]:
    found: dict[str, Connector] = {}
    for info in sorted(pkgutil.iter_modules(__path__), key=lambda item: item.name):
        if not info.ispkg or info.name == "shared" or info.name.startswith("_"):
            continue
        connector = _load(importlib.import_module(f"{__name__}.{info.name}"))
        if connector.type in found:
            raise RuntimeError(f"two connectors have the type {connector.type!r}")
        found[connector.type] = connector
    return found


CONNECTORS: dict[str, Connector] = _discover()
BY_LEGACY_ID: dict[str, Connector] = {c.legacy_id: c for c in CONNECTORS.values() if c.legacy_id}


def connector_for(source_id: str, values: Any) -> Connector | None:
    """The connector a configured source uses, or None if there isn't one."""
    declared = values.get("type") if isinstance(values, dict) else None
    if declared:
        return CONNECTORS.get(str(declared))
    return BY_LEGACY_ID.get(source_id) or CONNECTORS.get(str(source_id).split(":", 1)[0])


def collect(source_id: str, values: dict[str, Any]) -> dict[str, Any]:
    """Collect one configured source, as the source server.ingest() takes."""
    connector = connector_for(source_id, values)
    if connector is None:
        raise CollectorError("unknown source type")
    label = str(values.get("label") or connector.label)
    return build_source(source_id, label, connector.dimensions, connector.collect(values))


def describe() -> list[dict[str, Any]]:
    """Every connector's declaration, for setup tools and forms."""
    return [connector.describe() for connector in CONNECTORS.values()]


def example_config() -> dict[str, Any]:
    """A configuration with one source of each type, all disabled and empty."""
    sources = {}
    for connector in sorted(CONNECTORS.values(), key=lambda item: item.default_id):
        sources[connector.default_id] = {
            "type": connector.type, "enabled": False,
            **{item["key"]: FIELD_KINDS[item["kind"]] for item in connector.fields},
        }
    return {"poll_seconds": 60, "sources": sources}


def _split_addresses(raw: str) -> list[str]:
    return list(dict.fromkeys(part.strip() for part in re.split(r"[,;]", raw) if part.strip()))


def _slug(name: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")[:32]


def _ask_source(connector: Connector, ask: Callable[..., str], account: str = "") -> dict[str, Any] | None:
    """One source's settings, or None when its first required field is left blank."""
    values = {"type": connector.type, "enabled": True,
              **{item["key"]: FIELD_KINDS[item["kind"]] for item in connector.fields}}
    gate = next((item for item in connector.fields if item.get("required")), None)
    lead = f"{account}: " if account else ""
    for item in connector.fields:
        required = bool(item.get("required"))
        suffix = ", separated by commas" if item["kind"] == "addresses" else ""
        if item is gate:
            suffix += " (blank to skip)" if account else " (blank to disable)"
        elif not required:
            suffix += " (blank for none)"
        answer = ask(f"{lead}{item['prompt']}{suffix}").strip()
        if not answer:
            if item is gate:
                return None
            if required:
                raise ValueError(f"{item['prompt']} is required for {connector.name}.")
            continue
        if item["kind"] == "addresses":
            values[item["key"]] = _split_addresses(answer)
        elif item["kind"] == "number":
            try:
                number = float(answer)
            except ValueError:
                number = -1.0
            if not (math.isfinite(number) and number >= 0):
                raise ValueError(f"{item['prompt']} must be a number, 0 or more, with a decimal point.")
            values[item["key"]] = number
        else:
            values[item["key"]] = answer
    return values


def build_config(ask: Callable[..., str]) -> dict[str, Any]:
    """A configuration from answers to each connector's prompts.

    `ask(prompt)` returns an answer; `ask(prompt, secret=False)` is for one
    that needn't be masked (an account's name). A connector is enabled when
    its first required field is answered; left blank, it is skipped and stays
    disabled, and its other fields aren't asked. Once one is enabled, it
    offers another account of the same kind, named: "Work" becomes the
    source "binance:work", labelled Work in Finance.
    """
    config = example_config()
    sources = config["sources"]
    for connector in sorted(CONNECTORS.values(), key=lambda item: item.name.lower()):
        values = _ask_source(connector, ask)
        if values is None:
            continue
        sources[connector.default_id] = values
        while True:
            name = ask(f"Another {connector.name} account? Its name (blank for none)", secret=False).strip()[:64]
            if not name:
                break
            base = f"{connector.type}:{_slug(name) or 'account'}"
            source_id, number = base, 2
            while source_id in sources:
                source_id, number = f"{base}-{number}", number + 1
            extra = _ask_source(connector, ask, name)
            if extra is not None:
                sources[source_id] = {**extra, "label": name}
    return config
