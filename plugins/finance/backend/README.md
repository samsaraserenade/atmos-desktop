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
  (at most 50,000 rows).

Both say `"truncated": true` when the limit cut the answer short; the oldest
points are returned, so ask again from the last `t`/`ts_ms`. `/v1/info`
includes the retention settings. Money is always USD; Finance converts.

`/v1/history` also accepts repeated `exclude=source_id|holding_id`,
`excludeSource=source_id`, and `excludeGroup=source_id|group` parameters.
Hyperliquid supports the `perp` and `earn` groups.
Excluded rows are subtracted from Total, Spot, Perps, invested, and cash at
each stored poll without deleting the underlying itemized history.

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

The v1 routes require a bearer token. The deployed service listens on its
Tailscale address and is blocked from the public internet by the host firewall.

## Collectors

`collectors.py` supports Binance Spot, Aptos, Arbitrum, BSC, Cardano, Hyperliquid,
Injective, manual Monero, and Solana. Hyperliquid includes Spot, Perp, and
native Earn supply; Earn is assigned to the Perp balance. Trading 212 and
Litecoin are intentionally excluded. Each provider is isolated: a failed poll
keeps its previous confirmed value instead of collapsing the aggregate.

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

Provider configuration lives only at `/etc/atmos-portfolio-sources.json`, owned
by root and readable by the dedicated service group. The collector never logs
secrets or provider response bodies. `sources.example.json` contains the full
schema with every source disabled and no credentials.

Run `configure-sources.ps1` locally to enter configuration through masked
prompts. It connects to the server and SSH key given by `-Server` and
`-SshKeyPath`, or by `deploy.local.json` beside it (gitignored; copy
`deploy.example.json`). It keeps the generated document in memory and streams it directly to
the server over private SSH; it does not write a local credentials file.

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
cp .env.example .env                  # then set ATMOS_PORTFOLIO_TOKEN and ATMOS_PORTFOLIO_PUBLIC_URL
cp sources.example.json sources.json  # then enable your sources
sudo chown 10001:10001 sources.json && sudo chmod 600 sources.json
docker compose up -d --build
docker compose exec api python /app/server.py pairing
```

- Two containers from one image: `api` (the HTTP API) and `collector`, sharing
  the `portfolio-data` volume. Both run as uid 10001 on a read-only
  filesystem with no capabilities, and the same memory and CPU limits as the
  systemd units.
- `sources.json` is mounted read-only and has to be readable by uid 10001
  (the `chown` above). It holds any API keys, so keep it `600`.
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
sudo python3 /opt/atmos-portfolio/server.py pairing
```

prints a pairing code (`atmos-finance:…`) from `/etc/atmos-portfolio.env`:
the address Finance should use and the token. It contains the token, so paste
it only into Atmos (Portfolio Connections → Pairing code → Connect) and don't
keep it anywhere else. `install.sh` prints one at the end.

Finance accepts `https://` addresses, or plain `http://` only on a Tailscale
address or the same computer. The address comes from, in order: `--url`,
`ATMOS_PORTFOLIO_PUBLIC_URL` in the env file, or `http://HOST:PORT` from
`ATMOS_PORTFOLIO_HOST`/`ATMOS_PORTFOLIO_PORT`. So either:

- **Tailscale:** set `ATMOS_PORTFOLIO_HOST` to the server's Tailscale address
  (100.x.y.z) and restart `atmos-portfolio`; nothing is open to the internet.
- **HTTPS:** keep `ATMOS_PORTFOLIO_HOST=127.0.0.1`, put a TLS reverse proxy
  (for example Caddy: `portfolio.example.com { reverse_proxy 127.0.0.1:8787 }`)
  in front, and set `ATMOS_PORTFOLIO_PUBLIC_URL=https://portfolio.example.com`.

To change the token, edit `ATMOS_PORTFOLIO_TOKEN` (at least 32 characters),
restart `atmos-portfolio`, and pair Finance again.

`GET /v1/info` (token required) is what Finance's Test button calls: the
server's name, version, API version, number of sources and last update.
`GET /health` needs no token and says only that the service is up.
