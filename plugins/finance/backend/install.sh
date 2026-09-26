#!/usr/bin/env bash
set -euo pipefail

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
install -o root -g root -m 0644 "$stage/README.md" /opt/atmos-portfolio/README.md
install -o root -g root -m 0644 "$stage/atmos-portfolio.service" \
  /etc/systemd/system/atmos-portfolio.service
install -o root -g root -m 0644 "$stage/atmos-portfolio-collector.service" \
  /etc/systemd/system/atmos-portfolio-collector.service

if [[ ! -f /etc/atmos-portfolio.env ]]; then
  token="$(python3 -c 'import secrets; print(secrets.token_urlsafe(48))')"
  umask 0077
  printf '%s\n' \
    'ATMOS_PORTFOLIO_HOST=127.0.0.1' \
    'ATMOS_PORTFOLIO_PORT=8787' \
    'ATMOS_PORTFOLIO_DB=/var/lib/atmos-portfolio/portfolio.sqlite3' \
    "ATMOS_PORTFOLIO_TOKEN=$token" \
    > /etc/atmos-portfolio.env
fi
chown root:atmos-portfolio /etc/atmos-portfolio.env
chmod 0640 /etc/atmos-portfolio.env

if [[ ! -f /etc/atmos-portfolio-sources.json ]]; then
  install -o root -g atmos-portfolio -m 0640 "$stage/sources.example.json" \
    /etc/atmos-portfolio-sources.json
fi

systemctl daemon-reload
systemctl enable --now atmos-portfolio.service
systemctl enable atmos-portfolio-collector.service
health_host="$(sed -n 's/^ATMOS_PORTFOLIO_HOST=//p' /etc/atmos-portfolio.env | head -n 1)"
health_port="$(sed -n 's/^ATMOS_PORTFOLIO_PORT=//p' /etc/atmos-portfolio.env | head -n 1)"
curl --fail --silent --show-error "http://${health_host:-127.0.0.1}:${health_port:-8787}/health"
echo

# The pairing code for Atmos Finance. It contains the token: paste it only into Atmos.
if code="$(python3 /opt/atmos-portfolio/server.py pairing --env-file /etc/atmos-portfolio.env 2>&1)"; then
  printf '\nPairing code for Atmos Finance (Portfolio Connections > Pairing code):\n%s\n' "$code"
  case "$health_host" in 127.*|localhost|'')
    printf '\nThis address only works from this computer. To reach it from Atmos elsewhere, see\n"Pairing Finance with this server" in /opt/atmos-portfolio/README.md.\n' ;;
  esac
else
  printf '\n%s\nSee "Pairing Finance with this server" in /opt/atmos-portfolio/README.md.\n' "$code"
fi
