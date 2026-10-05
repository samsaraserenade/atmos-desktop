# Atmos portfolio backend

A dependency-free, single-user collector, history store, and read-only API
intended for a small VPS.

**Setting one up:** follow [SELF_HOSTING.md](SELF_HOSTING.md) (about 20
minutes, systemd or Docker). This README is the reference.

## Data model

- `portfolio_samples` retains compact total/invested/cash history indefinitely
  (one small row per poll).
- `current_holdings` stores only the latest itemized assets.
- `holdings_history` stores the itemized holdings at each poll, thinned as it
  ages (see Retention).
- `source_status` stores the latest state of each future connector.

## Retention

Every holding at every poll adds up quickly (about 70,000 rows a day for 50
holdings at a one-minute poll), so the collector thins `holdings_history`
when it starts and every six hours after:

| Age | Kept |
|---|---|
| Up to 30 days | every poll |
| 30 days to a year | the last poll of each hour |
| Older than a year | the last poll of each day |

These match what Finance asks for (raw and 5-minute points only within the
last 30 days, hourly up to a year, daily beyond), and the kept polls are
the ones its chart draws, so excluding holdings from the chart still works
over the whole history. `portfolio_samples` is never thinned.

Settings, in `/etc/atmos-portfolio.env`: `ATMOS_PORTFOLIO_RAW_DAYS` (30),
`ATMOS_PORTFOLIO_HOURLY_DAYS` (365), or `ATMOS_PORTFOLIO_RETENTION=off` to
keep everything. Restart `atmos-portfolio-collector` after changing them.

Deleted rows free space inside the database file for new rows, but the file
doesn't shrink. To shrink it after the first prune of a long history (this
needs free disk about the size of the database, and pauses writes while it
runs):

```sh
sudo -u atmos-portfolio python3 /opt/atmos-portfolio/server.py prune --vacuum
```

`server.py prune` without `--vacuum` runs the same thinning by hand.

## API

- `GET /health` — the service is up, and its version (no token).
- `GET /v1/info` — server name, version, API version, source count and last update.
- `GET /v1/portfolio` — latest total, holdings, and source states.
- `GET /v1/history?from=...&to=...&resolution=raw|5m|1h|1d` — bounded history
  (at most 10,000 points).
- `GET /v1/holdings-history?from=...&to=...` — itemized point-in-time holdings
  (at most 20,000 rows; 50,000 before 0.9.1). Ask for a few minutes around
  the time you want, as Finance does, not a day of every poll.

Both say `"truncated": true` when the limit cut the answer short; the oldest
points are returned, so ask again from the last `t`/`ts_ms`. `/v1/info`
includes the retention settings. Money is always USD; Finance converts.

These two answers are built one at a time (0.9.1): they're what takes the
memory and the CPU, and the service is capped at 160 MB and a quarter of a
CPU. Before, two large holdings-history answers at once could get it killed
for memory and restarted (`systemctl show atmos-portfolio -p NRestarts`).
Each answer is logged with its path, status, time and size, never its
query: `journalctl -u atmos-portfolio` shows what's slow.

`/v1/history` also accepts repeated `exclude=source_id|holding_id`,
`excludeSource=source_id`, and `excludeGroup=source_id|group` parameters.
Hyperliquid supports the `perp` and `earn` groups.
Excluded rows are subtracted from Total, Spot, Perps, invested, and cash at
each point returned without deleting the underlying itemized history; only
the holdings behind those points are read (each bucket's newest sample, by
primary key), not every poll in the range. Finance draws one coin's history
as the total less the total without it, so the two line up exactly.

Holdings carry a stable `holding_id` plus small classification metadata for
dApp, protocol type, exchange/counterparty, chain, and wallet address. Equal
tokens in different Solana wallets remain separate records instead of being
merged. Hyperliquid collateral and Earn remain in the Perps book; Earn is
classified as Lending and open positions as Perpetuals.

Capital allocation and market exposure are deliberately different views.
Capital uses holding equity/value to answer where funds sit. Exposure uses
signed perpetual notional (shorts are negative) netted against Spot assets.
The existing `spot` and `perp` history columns stay separate, while holdings
history retains the metadata needed for historical allocation analysis.

The v1 routes require a bearer token: each paired device has its own (see
"Paired devices"). By default the service listens on 127.0.0.1 only; see "Pairing Finance with this server" for Tailscale or
HTTPS. Keep it off the public internet.

Tests: `python3 -m unittest discover -s . -p 'test_*.py'` in this folder
(`upgrade.sh` runs them too).

## Connectors

The server reads each source through a connector: Binance Spot, Aptos,
Arbitrum, BSC, Cardano, Hyperliquid, Injective, manual Monero, and Solana.
Hyperliquid includes Spot, Perp, and native Earn supply; Earn is assigned to
the Perp balance. Trading 212 and Litecoin are intentionally excluded. Each
source is isolated: a failed poll keeps its previous confirmed value instead
of collapsing the aggregate.

`collectors.py` is the runner: it reads the configuration, collects every
enabled source through its connector, and stores the result. The connectors
are in `connectors/`, one folder each, found when it starts:

```
connectors/
  shared/        network access, prices, EVM and holding helpers
  binance/       __init__.py: CONNECTOR (what it is) and collect(config)
  solana/        __init__.py, plus chain.py, jupiter.py, pump.py
  ...
```

A connector's `CONNECTOR` declares its `type`, a `name` and `label`, its
configuration `fields` (in the order to ask for them: `addresses`, `secret`
or `number`, and which are required) and its `dimensions` (the dapp, chain
and so on each holding defaults to). `collect(config)` returns
`shared.collected(holdings, errors, wallet_addresses)`. It doesn't name its
source: the runner does, from the configuration, so one connector can serve
several sources. Everything else comes from the declarations:
`collectors.py connectors` lists them, `collectors.py example-config` writes
`sources.example.json` (a test checks it is current), and
`collectors.py configure` asks for each field. **Adding a connector** is
adding a folder, then regenerating `sources.example.json`.

### The configuration

Each entry under `sources` is one source, by its id:

```json
{
  "poll_seconds": 60,
  "sources": {
    "solana-wallet": { "type": "solana", "enabled": true, "addresses": ["..."] },
    "binance:work":  { "type": "binance", "enabled": true, "label": "Work", "api_key": "...", "api_secret": "..." }
  }
}
```

`type` names the connector. Without it, the id says: each connector's
original id (`solana-wallet`, `binance-spot`, ...) or an id of the form
`<type>` or `<type>:<name>`. Keep existing ids as they are: Finance's history
and your hidden sources and holdings are keyed by them. `label` (optional)
replaces the connector's label in Finance. Several sources of one type work
the same way, Hyperliquid's Perp and Earn balances included.

### Groups

A holding whose meta has `group` belongs to that balance of its source:
Hyperliquid puts its collateral and positions in `perp` and its Earn supply
in `earn`, and declares both under `groups`. Finance includes or leaves a
group out as a whole (`excludeGroup=<source>|<group>` on `/v1/history`), never
one of its holdings on its own, and shows each group of a derivatives account
as a balance in its Futures widget. Any connector can group holdings the same
way. Rows stored before 0.8 have no `group`; `server.py` fills it in for them
(`_legacy_meta`, the one place it names Hyperliquid).

The BSC source reads native BNB and Binance-Peg BSC USDT directly through
chain RPC. It does not depend on the anonymous Ankr portfolio indexer, which
may reject uncredentialed requests.

Solana collection includes governance-staked and unstaking JUP through
Jupiter's legacy portfolio endpoint, plus configured Jupiter Lock escrows read
directly from their on-chain token vaults. Locked balances therefore follow
claims automatically without duplicating tokens received by the wallet.
Successful staking responses are cached for five minutes, and the last
confirmed position is retained across temporary Jupiter failures. An optional
Jupiter API key remains confined to the protected provider configuration.
When Jupiter has no price for a wallet token, the collector also checks the
mint's official Pump bonding-curve account. Incomplete, SOL-paired Pump tokens
are valued from their on-chain virtual reserves and the existing SOL/USD price;
completed curves, non-SOL quote pairs, and unrelated unpriced mints are left
untouched. Curve reads are batched and briefly cached, and require no new API
key or web service.

### Where the sources are kept

The sources (API keys and wallet addresses) are encrypted at rest. With
systemd 250 or later (Ubuntu 24.04, Debian 12) they live in
`/etc/atmos-portfolio/sources.cred`, encrypted by `systemd-creds` with this
machine's host key (`/var/lib/systemd/credential.secret`, root only). Not
with its TPM: a firmware or Secure Boot update can change what the TPM
measures and lock a TPM-bound file for good. When the collector starts,
systemd decrypts them into the service's private credentials folder, in
memory (`LoadCredentialEncrypted=`, in a drop-in beside the unit), and the
service's own user can't read the encrypted file. On systemd 247 to 249
(Ubuntu 22.04) they stay in `/etc/atmos-portfolio-sources.json`, readable
by root only, and reach the collector the same way; before 247 the file
stays readable by the service's group, as before 0.9. `install.sh` and
`upgrade.sh` set this up (`sources.sh setup`), encrypting a plain file they
find and removing it once the collector is running with the encrypted copy
(if it doesn't stay up, everything is put back).

On a server upgraded from before 0.9, `shred` can't promise the old plain
file is unrecoverable from the disk (journaling filesystems and SSDs keep
old blocks). If that matters, rotate the API keys it held: `sources.sh edit`
with new read-only keys.

Root on the server can still decrypt them: that's what lets the collector
run unattended. What it guards against is the file leaving the machine on
its own, in a backup of `/etc`, a copy or a support bundle: it only opens
with this machine's host key. A whole-disk image carries the key too. The collector never logs secrets or provider response bodies.
`sources.example.json` has every source disabled and no credentials.

Everything goes through `sources.sh` on the server:

```sh
sudo /opt/atmos-portfolio/sources.sh configure   # every source, masked prompts
sudo /opt/atmos-portfolio/sources.sh edit        # change them in $EDITOR
sudo /opt/atmos-portfolio/sources.sh show [FILE] # print them, or write FILE (mode 600)
sudo /opt/atmos-portfolio/sources.sh seal FILE   # replace them with FILE's
```

Each checks the result, stores it and restarts the collector with it, and
keeps the previous sources if the collector doesn't stay up; `edit` and
`configure` work on a copy in a private folder in `/run` (memory), removed
afterwards with anything the editor left there.
`configure` asks for every source, and after each one you use, offers another
account of the same kind: name it ("Work") and it becomes `binance:work`,
labelled Work. It writes the whole configuration each time, so use `edit` to
change one source. To move to another server, `show FILE` on the old one,
`seal FILE` on the new one, and delete the file on both.

From Windows, `configure-sources.ps1` runs `sources.sh configure` over SSH,
with the server and SSH key given by `-Server` and `-SshKeyPath` or by
`deploy.local.json` beside it (gitignored; copy `deploy.example.json`).
Nothing is written on your PC.

## Atmos client mode

Finance pairs with this server from its Portfolio Connections widget, with a
pairing code or the server's address and token. Finance keeps them sealed
with the system's secure storage; the token is read only by the plugin's main
process and is never sent to the renderer. Earlier versions read
`%AppData%\atmos\portfolio-vps.json`; Finance moves that file into its
sealed store on first run.

The renderer receives normalized portfolio data and tiered aggregate history:
daily for old history, hourly and five-minute points for intermediate ranges,
and raw points for the most recent two days. In VPS mode this server history is
the chart's sole source; old local chart data is left intact on disk but ignored.
The desktop refreshes VPS history while it remains open, so a transient startup
failure recovers automatically.

## Running with Docker

An alternative to `install.sh` and systemd, for a server that already runs
Docker. From this folder:

```sh
cp .env.example .env                  # then set ATMOS_PORTFOLIO_PUBLIC_URL
cp sources.example.json sources.json  # then enable your sources
sudo chown 10001:10001 sources.json && sudo chmod 600 sources.json
docker compose up -d --build
docker compose exec api python /app/server.py device add laptop
```

- Two containers from one image: `api` (the HTTP API) and `collector`, sharing
  the `portfolio-data` volume. Both run as uid 10001 on a read-only
  filesystem with no capabilities, and the same memory and CPU limits as the
  systemd units.
- `sources.json` is mounted read-only and has to be readable by uid 10001
  (the `chown` above). It holds any API keys, so keep it `600`. With Docker
  it is not encrypted at rest (there is no systemd to decrypt it); keep it
  out of backups that leave the server, or run the systemd install instead.
- The API is published on `127.0.0.1:8787` only. For Tailscale, set
  `ATMOS_PORTFOLIO_BIND` in `.env` to the server's 100.x.y.z address and
  `ATMOS_PORTFOLIO_PUBLIC_URL=http://100.x.y.z:8787`. For HTTPS, leave the
  bind alone, put a TLS proxy in front, and set the public URL to its
  `https://` address.
- `ATMOS_PORTFOLIO_PUBLIC_URL` is required for the pairing code: inside the
  container the server listens on every interface, so it can't tell which
  address Finance should use.
- After editing `sources.json` or `.env`: `docker compose up -d` (it
  recreates what changed). To upgrade: pull the new files, then
  `docker compose up -d --build`; the server migrates the database itself.

## Backups

```sh
sudo -u atmos-portfolio python3 /opt/atmos-portfolio/server.py backup --out /var/lib/atmos-portfolio/backups/portfolio-$(date +%F).sqlite3
docker compose exec api python /app/server.py backup --out /data/backups/portfolio-$(date +%F).sqlite3   # Docker
```

`backup` makes a consistent copy while the server is running (SQLite's
online backup), and refuses to overwrite a file. Copy it off the server;
with Docker, `docker compose cp api:/data/backups .` brings the folder out.
To restore, stop both services and put the copy in place of
`portfolio.sqlite3`.

## Pairing Finance with this server

```sh
sudo python3 /opt/atmos-portfolio/server.py device add laptop
```

pairs a device called "laptop" and prints its pairing code
(`atmos-finance:…`): the address Finance should use and that device's own
token. Paste it only into Atmos on that device (Portfolio Connections →
Pairing code → Connect) and don't keep it anywhere else. `install.sh` pairs
a first device and prints its code at the end (`sudo ./install.sh laptop`
names it). `server.py pairing [--name NAME]` does the same as `device add`.

Finance accepts `https://` addresses, or plain `http://` only on a Tailscale
address or the same computer. The address comes from, in order: `--url`,
`ATMOS_PORTFOLIO_PUBLIC_URL` in the env file, or `http://HOST:PORT` from
`ATMOS_PORTFOLIO_HOST`/`ATMOS_PORTFOLIO_PORT`. So either:

- **Tailscale:** set `ATMOS_PORTFOLIO_HOST` to the server's Tailscale address
  (100.x.y.z) and restart `atmos-portfolio`; nothing is open to the internet.
- **HTTPS:** keep `ATMOS_PORTFOLIO_HOST=127.0.0.1`, put a TLS reverse proxy
  (for example Caddy: `portfolio.example.com { reverse_proxy 127.0.0.1:8787 }`)
  in front, and set `ATMOS_PORTFOLIO_PUBLIC_URL=https://portfolio.example.com`.

### Paired devices

```sh
sudo python3 /opt/atmos-portfolio/server.py device list            # names, when paired, last used
sudo python3 /opt/atmos-portfolio/server.py device revoke laptop   # its next request is refused
```

Each device has its own random token. The server keeps only a SHA-256 hash
of it, so a lost pairing code can't be shown again: revoke the device and add
it again. Revoking takes effect at once, without a restart, and leaves the
other devices alone. Run with `sudo`, these commands act as the service's
user, so the database stays its own. With Docker: `docker compose exec api
python /app/server.py device …`.

Before 0.9 every device shared one token, `ATMOS_PORTFOLIO_TOKEN` in
`/etc/atmos-portfolio.env` (or `.env`). It is still accepted while it's set
(`device list` says so). To move off it: `device add` each device and paste
its new code into Finance there, then delete the `ATMOS_PORTFOLIO_TOKEN`
line and restart `atmos-portfolio`.

`GET /v1/info` (token required) is what Finance's Test button calls: the
server's name, version, API version, the device asking, number of sources
and last update.
`GET /health` needs no token and says only that the service is up, and its version.

## Licence

This backend is licensed under the [GNU Affero General Public License,
version 3](LICENSE) (the rest of Atmos is GPLv3; see the repository's
NOTICE). You can run, change and self-host it freely. If you run a modified
version for other people over a network, you must offer them its source
under the same licence.
