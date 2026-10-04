#!/usr/bin/env bash
set -euo pipefail

# sudo ./install.sh [NAME]: installs or updates the services and, on a fresh
# install, pairs a first device called NAME ("first device" if omitted).
#
# The folder holding this script and the files it installs (a copy of
# plugins/finance/backend on the server).
stage="$(cd -- "$(dirname -- "$0")" && pwd)"
[[ $EUID -eq 0 ]] || { echo 'Run with sudo.'; exit 1; }

if ! id -u atmos-portfolio >/dev/null 2>&1; then
  useradd --system --home-dir /var/lib/atmos-portfolio \
    --shell /usr/sbin/nologin --user-group atmos-portfolio
fi

install -d -o root -g root -m 0755 /opt/atmos-portfolio
install -o root -g root -m 0755 "$stage/server.py" /opt/atmos-portfolio/server.py
install -o root -g root -m 0755 "$stage/collectors.py" /opt/atmos-portfolio/collectors.py
install -o root -g root -m 0755 "$stage/sources.sh" /opt/atmos-portfolio/sources.sh
# The connectors, one folder each (without any Python caches from the copy).
rm -rf /opt/atmos-portfolio/connectors
cp -R "$stage/connectors" /opt/atmos-portfolio/connectors
find /opt/atmos-portfolio/connectors -name __pycache__ -prune -exec rm -rf {} +
chown -R root:root /opt/atmos-portfolio/connectors
chmod -R u=rwX,go=rX /opt/atmos-portfolio/connectors
install -o root -g root -m 0644 "$stage/README.md" /opt/atmos-portfolio/README.md
install -o root -g root -m 0644 "$stage/atmos-portfolio.service" \
  /etc/systemd/system/atmos-portfolio.service
install -o root -g root -m 0644 "$stage/atmos-portfolio-collector.service" \
  /etc/systemd/system/atmos-portfolio-collector.service

# No shared token: each device Finance runs on is paired with a token of its
# own (server.py device add), which can be revoked on its own.
if [[ ! -f /etc/atmos-portfolio.env ]]; then
  umask 0077
  printf '%s\n' \
    'ATMOS_PORTFOLIO_HOST=127.0.0.1' \
    'ATMOS_PORTFOLIO_PORT=8787' \
    'ATMOS_PORTFOLIO_DB=/var/lib/atmos-portfolio/portfolio.sqlite3' \
    > /etc/atmos-portfolio.env
fi
chown root:atmos-portfolio /etc/atmos-portfolio.env
chmod 0640 /etc/atmos-portfolio.env

# The sources start as the example (every source off), then sources.sh
# encrypts them (systemd-creds) and hands them to the collector in memory.
if [[ ! -f /etc/atmos-portfolio/sources.cred && ! -f /etc/atmos-portfolio-sources.json ]]; then
  install -o root -g root -m 0600 "$stage/sources.example.json" \
    /etc/atmos-portfolio-sources.json
fi
systemctl daemon-reload
/opt/atmos-portfolio/sources.sh setup

systemctl daemon-reload
systemctl enable --now atmos-portfolio.service
systemctl enable atmos-portfolio-collector.service
health_host="$(sed -n 's/^ATMOS_PORTFOLIO_HOST=//p' /etc/atmos-portfolio.env | head -n 1)"
health_port="$(sed -n 's/^ATMOS_PORTFOLIO_PORT=//p' /etc/atmos-portfolio.env | head -n 1)"
curl --fail --silent --show-error "http://${health_host:-127.0.0.1}:${health_port:-8787}/health"
echo

# The first device's pairing code, on a fresh install. It contains that
# device's token: paste it only into Atmos.
as_service() { runuser -u atmos-portfolio -- python3 /opt/atmos-portfolio/server.py "$@" --env-file /etc/atmos-portfolio.env; }
if as_service device list | grep -q '^No devices paired' && ! grep -q '^ATMOS_PORTFOLIO_TOKEN=.' /etc/atmos-portfolio.env; then
  problem="$(mktemp)"
  if code="$(as_service device add "${1:-first device}" 2>"$problem")"; then
    printf '\nPairing code for Atmos Finance (Portfolio Connections > Pairing code):\n%s\n' "$code"
    case "$health_host" in 127.*|localhost|'')
      printf '\nThis address only works from this computer. To reach it from Atmos elsewhere, see\n"Pairing Finance with this server" in /opt/atmos-portfolio/README.md.\n' ;;
    esac
  else
    printf '\n%s\nNo pairing code yet: see "Pairing Finance with this server" in /opt/atmos-portfolio/README.md.\n' "$(cat "$problem")"
  fi
  rm -f "$problem"
else
  printf '\nPaired devices: sudo python3 /opt/atmos-portfolio/server.py device list\n'
fi
