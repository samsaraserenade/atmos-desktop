# Self-hosting the Finance portfolio server

Finance's watchlist and markets chart work on their own. To track your own
portfolio, Finance reads it from a small server that you run. The server
polls your wallets and exchange accounts every minute, keeps the history,
and answers Finance over a token-protected API. This guide takes about 20
minutes.

> Finance and this server only **read**. They never move funds or place
> orders. Balances are estimates from third-party prices, and nothing here is
> financial advice. Give the server **read-only** API keys.

## What you need

- An always-on Linux machine: a small VPS (1 vCPU, 512 MB RAM is plenty) or
  a home server. Ubuntu 22.04+ or Debian 12+ are tested; anything with
  systemd and Python 3.10+ works. With Docker, any OS that runs Docker works.
- A way for Atmos to reach it: **Tailscale** (easiest, nothing opened to the
  internet), or a domain name for **HTTPS**.
- The addresses of the wallets you want to track, and, for Binance, a
  read-only API key.

## 1. Get the server files

On the server:

```sh
git clone --depth 1 https://github.com/samsaraserenade/atmos-desktop.git
cd atmos-desktop/plugins/finance/backend
```

Everything the server needs is in this folder. It has no dependencies
beyond Python's standard library.

## 2. Install

Pick one.

### A. systemd (recommended on a VPS)

```sh
sudo bash install.sh
```

This creates an `atmos-portfolio` system user, installs the API and the
collector as two sandboxed systemd services, writes its settings to
`/etc/atmos-portfolio.env`, and starts the sources with every one off,
encrypted with `systemd-creds` (systemd 250+, so Ubuntu 24.04 or Debian 12;
on Ubuntu 22.04 the file is readable by root only instead). The API starts
listening on `127.0.0.1:8787`, and the script pairs a first device and
prints its code at the end (you'll make another after step 4).

### B. Docker Compose

```sh
cp .env.example .env
cp sources.example.json sources.json
sudo chown 10001:10001 sources.json && sudo chmod 600 sources.json
```

Leave `docker compose up` until step 4, after the sources and the address
are set. The details are under "Running with Docker" in `README.md`.

## 3. Tell it what to track

Edit the sources: `sudo /opt/atmos-portfolio/sources.sh edit` with systemd
(it opens a copy in memory, then encrypts it again and restarts the
collector), or `sources.json` with Docker. Set `"enabled": true` on the
sources you use and fill them in:

| Source | Fill in |
|---|---|
| `solana-wallet` | `addresses`. Optional: `jupiter_api_key`, `jupiter_locks` |
| `hyperliquid-wallet` | `addresses` (your EVM address): Spot, Perps and Earn |
| `arbitrum-wallet`, `bsc-wallet` | `addresses` (EVM) |
| `aptos-wallet`, `cardano-wallet`, `inj-wallet` | `addresses` |
| `binance-spot` | `api_key`, `api_secret`: create a key with **read permission only** |
| `monero-wallet` | `amount` (entered by hand; the server never sees your Monero wallet) |

`poll_seconds` (default 60, minimum 30) sets how often it collects. Wallet
sources only need public addresses. Binance is the only source that needs a
secret. With systemd, the sources are encrypted on disk and only the
collector gets them, in memory; with Docker, `sources.json` is plain text
readable only by the container's user.

Or let the server ask: `sudo /opt/atmos-portfolio/sources.sh configure`
prompts for each source with masked input (blank keeps a source disabled).
On Windows, `configure-sources.ps1` runs that over SSH, so no secrets land
on your PC.
After each source you use it offers another account of the same kind (a
work Binance account, a second set of wallets); in the file these are
sources like `"binance:work": { "type": "binance", ... }` (see "The
configuration" in `README.md`).

With systemd, `sources.sh` restarts the collector with them. With Docker,
they're read at the next poll.

## 4. Make it reachable from Atmos

Finance accepts `https://` addresses anywhere, and plain `http://` only on
a Tailscale address or the same computer.

### Tailscale

1. Install Tailscale on the server and on the computer running Atmos, and
   sign both into the same tailnet. `tailscale ip -4` on the server shows
   its address (100.x.y.z).
2. systemd: set `ATMOS_PORTFOLIO_HOST=100.x.y.z` in
   `/etc/atmos-portfolio.env`, then `sudo systemctl restart atmos-portfolio`.
   Docker: set `ATMOS_PORTFOLIO_BIND=100.x.y.z` and
   `ATMOS_PORTFOLIO_PUBLIC_URL=http://100.x.y.z:8787` in `.env`.

Nothing is open to the internet; only your own devices on the tailnet can
connect.

### HTTPS with Caddy

1. Point a DNS name (say `portfolio.example.com`) at the server, and open
   ports 80 and 443.
2. Install [Caddy](https://caddyserver.com/docs/install) and put this in
   `/etc/caddy/Caddyfile`:

   ```
   portfolio.example.com {
     reverse_proxy 127.0.0.1:8787
   }
   ```

   then `sudo systemctl reload caddy`. Caddy gets and renews the certificate.
3. Keep the API on `127.0.0.1`, and set
   `ATMOS_PORTFOLIO_PUBLIC_URL=https://portfolio.example.com` in
   `/etc/atmos-portfolio.env` (or `.env` with Docker).

Every `/v1` request needs a paired device's token, and `/health` says only that the
server is up, and its version. Don't publish port 8787 itself.

Docker users can now start it: `docker compose up -d --build`.

## 5. Pair Finance

```sh
sudo python3 /opt/atmos-portfolio/server.py device add laptop      # systemd
docker compose exec api python /app/server.py device add laptop     # Docker
```

This pairs a device called "laptop" and prints its code, starting
`atmos-finance:`. The code holds that device's own token, so paste it only
into Atmos on that device: **Portfolio Connections → Pairing code → Test →
Connect**. Pair each computer (or phone) separately. Finance stores it sealed with your system's secure storage.
Within a minute of the first collection, your balance appears.

## Looking after it

- **Status:** `sudo python3 /opt/atmos-portfolio/collectors.py --status` shows
  each source and its error count. Logs: `journalctl -u atmos-portfolio-collector`
  (or `docker compose logs collector`). A source that fails keeps its last
  good value until it recovers.
- **Backups:** `server.py backup --out FILE` makes a consistent copy while it
  runs (see "Backups" in `README.md`). Copy it off the server.
- **Upgrades:** pull the new files (`git pull` in the clone), then
  `sudo bash upgrade.sh`. It backs up the database and the running version,
  tests the migration on a copy, installs, and rolls back if anything fails.
  With Docker: `docker compose up -d --build`.
- **Disk use:** itemized history is thinned as it ages (every poll for 30 days,
  hourly to a year, daily after), which keeps the database small with no
  effect on Finance's charts. See "Retention" in `README.md`.
- **Devices:** `server.py device list` shows the paired devices and when
  each last connected; `server.py device revoke laptop` locks one out at
  once (a lost laptop, an old phone) without touching the others. Pair it
  again with `device add`.
- **Moving servers:** encrypted sources only open on the machine that wrote
  them. `sudo /opt/atmos-portfolio/sources.sh show sources.json` on the
  old server (readable by you only), copy it over,
  `sudo /opt/atmos-portfolio/sources.sh seal sources.json` on the new one,
  then delete `sources.json` on both.

## If something's wrong

| Finance says | Check |
|---|---|
| "use https://, or http:// only on a Tailscale address…" | The address in the code is plain `http://` on a public IP. Use Tailscale or HTTPS (step 4). |
| Test can't reach the server | Tailscale running on both machines? `curl http://ADDRESS:8787/health` from the Atmos computer. With Caddy: `curl https://NAME/health`. |
| "unauthorized" | The device was revoked, or paired with the shared token that was since removed. `device add` it again. |
| Connected, but no balance | No source enabled, or the collector isn't running: `collectors.py --status` and the collector's logs. |
| One source shows errors | Its addresses or key are wrong, or its provider is down. Other sources are unaffected. |
