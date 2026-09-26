#!/usr/bin/env bash
set -euo pipefail
stage="$(cd -- "$(dirname -- "$0")" && pwd)"
[[ $EUID -eq 0 ]] || { echo 'Run with sudo.'; exit 1; }
source /etc/atmos-portfolio.env
db="${ATMOS_PORTFOLIO_DB:-/var/lib/atmos-portfolio/portfolio.sqlite3}"
backup="/var/backups/atmos-portfolio-$(date -u +%Y%m%dT%H%M%SZ)"
install -d -m 0700 "$backup"
cp -a /opt/atmos-portfolio/server.py /opt/atmos-portfolio/collectors.py "$backup/"
cd "$stage"
python3 -m unittest discover -s . -p 'test_*.py'
# Snapshot safely even when SQLite has a WAL file.
python3 - "$db" "$backup/portfolio.sqlite3" <<'PY'
import sqlite3,sys
with sqlite3.connect(sys.argv[1]) as source, sqlite3.connect(sys.argv[2]) as target:
    source.backup(target)
PY
cp "$backup/portfolio.sqlite3" "$backup/migration-test.sqlite3"
python3 server.py init --db "$backup/migration-test.sqlite3"
python3 server.py integrity --db "$backup/migration-test.sqlite3"
systemctl stop atmos-portfolio-collector.service atmos-portfolio.service
# Final backup after stopping writers is the rollback point.
python3 - "$db" "$backup/portfolio.sqlite3" <<'PY'
import sqlite3,sys
with sqlite3.connect(sys.argv[1]) as source, sqlite3.connect(sys.argv[2]) as target:
    source.backup(target)
PY
rollback() {
  echo "Upgrade failed; restoring $backup"
  systemctl stop atmos-portfolio-collector.service atmos-portfolio.service || true
  cp "$backup/server.py" "$backup/collectors.py" /opt/atmos-portfolio/
  python3 - "$backup/portfolio.sqlite3" "$db" <<'PY'
import sqlite3,sys
with sqlite3.connect(sys.argv[1]) as source, sqlite3.connect(sys.argv[2]) as target:
    source.backup(target)
PY
  systemctl start atmos-portfolio.service atmos-portfolio-collector.service
}
trap 'rollback' ERR
install -o root -g root -m 0755 server.py collectors.py /opt/atmos-portfolio/
python3 /opt/atmos-portfolio/server.py init --db "$db"
python3 /opt/atmos-portfolio/server.py integrity --db "$db"
systemctl start atmos-portfolio.service
systemctl start atmos-portfolio-collector.service
sleep 5
systemctl is-active atmos-portfolio.service atmos-portfolio-collector.service
trap - ERR
echo "Upgrade installed. Backup: $backup"
