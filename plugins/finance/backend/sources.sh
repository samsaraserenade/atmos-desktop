#!/usr/bin/env bash
# The collector's sources (API keys, wallet addresses), kept encrypted at rest.
#
# With systemd 250 or later (Ubuntu 24.04, Debian 12) the sources live in
# /etc/atmos-portfolio/sources.cred, encrypted by systemd-creds with this
# machine's host key (not its TPM, which a firmware update could lock out).
# systemd decrypts them into the
# collector's private, in-memory credentials folder when it starts; this
# script never writes them to disk in plain text, and the service's user
# can't read the file.
# On older systemd (Ubuntu 22.04) they stay in /etc/atmos-portfolio-sources.json,
# readable by root only, and reach the collector the same way.
#
#   sudo sources.sh setup        choose the mode, encrypt a plain file, wire the
#                                collector (install.sh and upgrade.sh run it)
#   sudo sources.sh configure    ask for every source's settings (masked)
#   sudo sources.sh edit         change them in $EDITOR (a copy in memory)
#   sudo sources.sh show [FILE]  print them, or write them to FILE (mode 600)
#   sudo sources.sh seal FILE    replace them with FILE's (FILE is left alone)
#
# An encrypted file only opens on the machine that wrote it. To move servers,
# `sources.sh show FILE` on the old one, `seal FILE` on the new one, then
# delete FILE on both. (Before systemd 247 there are no credentials: the
# file stays readable by the service's group, as before 0.9.)
set -euo pipefail

app=/opt/atmos-portfolio
cred_dir=/etc/atmos-portfolio
cred="$cred_dir/sources.cred"
plain=/etc/atmos-portfolio-sources.json
dropin_dir=/etc/systemd/system/atmos-portfolio-collector.service.d
dropin="$dropin_dir/sources.conf"
group="${ATMOS_SOURCES_GROUP:-atmos-portfolio}"
collector=atmos-portfolio-collector.service
# Tests point these elsewhere; nothing else should.
app="${ATMOS_SOURCES_APP:-$app}"
cred_dir="${ATMOS_SOURCES_CRED_DIR:-$cred_dir}"
cred="$cred_dir/sources.cred"
plain="${ATMOS_SOURCES_PLAIN:-$plain}"
dropin_dir="${ATMOS_SOURCES_DROPIN_DIR:-$dropin_dir}"
dropin="$dropin_dir/sources.conf"

die() { echo "sources.sh: $*" >&2; exit 1; }
[[ $EUID -eq 0 ]] || die 'run with sudo'
umask 077

use_systemctl() { [[ -z "${ATMOS_SOURCES_NO_SYSTEMCTL:-}" ]] && command -v systemctl >/dev/null 2>&1; }
systemd_version() {
  if [[ -n "${ATMOS_SOURCES_SYSTEMD_VERSION:-}" ]]; then echo "$ATMOS_SOURCES_SYSTEMD_VERSION"; return; fi
  local version
  version="$(systemctl --version 2>/dev/null | awk 'NR == 1 { print $2 + 0 }')"
  echo "${version:-0}"
}
# How the sources are kept: "encrypted" (systemd-creds, systemd 250+),
# "credential" (plain, root only, LoadCredential=, systemd 247+), or
# "legacy" (plain, readable by the service's group, read by the collector).
mode() {
  if [[ -z "${ATMOS_SOURCES_FORCE_PLAIN:-}" ]] && command -v systemd-creds >/dev/null 2>&1; then
    echo encrypted
  elif (( $(systemd_version) >= 247 )); then
    echo credential
  else
    echo legacy
  fi
}

check() {  # the file (an absolute path) is a configuration the collector accepts
  local problem
  problem="$(cd "$app" && python3 -c '
import sys, collectors
try:
    collectors.load_config(sys.argv[1])
except Exception as error:
    print(error)' "$1")" || problem="the check couldn't run"
  [[ -z "$problem" ]] || die "$problem; nothing was changed"
}

# Plain text only ever goes in a private folder in memory (/run is a tmpfs),
# removed on exit with anything an editor left beside it.
scratch_dir=""
cleanup() { [[ -z "$scratch_dir" ]] || rm -rf "$scratch_dir"; }
trap cleanup EXIT
scratch() {  # $REPLY: a new private file
  [[ -n "$scratch_dir" ]] || scratch_dir="$(mktemp -d "${ATMOS_SOURCES_RUN:-/run}/atmos-portfolio-sources.XXXXXX")"
  REPLY="$(mktemp "$scratch_dir/sources.XXXXXX")"
}

decrypt_to() {  # current sources -> $1
  if [[ -f "$cred" ]]; then
    systemd-creds decrypt --name=sources "$cred" "$1"
  elif [[ -f "$plain" ]]; then
    cat "$plain" > "$1"
  else
    die "no sources yet: run sources.sh configure"
  fi
}

# Restart the collector ($1: restart, or try-restart to leave a stopped one
# stopped) and, if it should be running, check it stays up.
restart_and_check() {
  use_systemctl || return 0
  local was_active=""
  systemctl is-active --quiet "$collector" && was_active=1
  systemctl daemon-reload
  systemctl "$1" "$collector" || return 1
  if [[ "$1" == restart || -n "$was_active" ]]; then
    sleep "${ATMOS_SOURCES_SETTLE:-3}"
    systemctl is-active --quiet "$collector"
  fi
}

dropin_text() {
  local line
  case "$(mode)" in
    encrypted) line="LoadCredentialEncrypted=sources:$cred" ;;
    credential) line="LoadCredential=sources:$plain" ;;
    *) return 0 ;;
  esac
  printf '%s\n' \
    '# Written by sources.sh: where the collector gets its sources. systemd' \
    '# decrypts or copies them into $CREDENTIALS_DIRECTORY, in memory, at start.' \
    '[Service]' "$line"
}

write_dropin() {  # $1: the text (empty: no drop-in)
  if [[ -z "$1" ]]; then
    rm -f "$dropin"
  elif [[ ! -f "$dropin" ]] || [[ "$(cat "$dropin")" != "$1" ]]; then
    install -d -m 0755 "$dropin_dir"
    printf '%s\n' "$1" > "$dropin.tmp"
    chmod 0644 "$dropin.tmp"
    mv -f "$dropin.tmp" "$dropin"
  fi
}

scrub() {  # remove plain-text files, overwriting them first where that helps
  local file
  for file in "$@"; do
    if [[ -f "$file" ]]; then
      shred -u "$file" 2>/dev/null || rm -f "$file"
      echo "Removed the plain-text $file."
    fi
  done
}
remove_plain() { scrub "$plain"; }
# What the old configure-sources.ps1 left behind if it failed half way.
remove_leftovers() { scrub "$(dirname "$plain")/.$(basename "$plain").new" "$(dirname "$plain")/.$(basename "$plain").new.tmp"; }

# FILE -> the stored sources, then the collector restarted with them ($2:
# restart or try-restart). If it doesn't stay up, everything is put back.
store() {
  local source how="${2:-restart}" previous_dropin=""
  source="$(realpath -e -- "$1")" || die "no file $1"
  check "$source"
  [[ -f "$dropin" ]] && previous_dropin="$(cat "$dropin")"
  if [[ "$(mode)" == encrypted ]]; then
    install -d -o root -g root -m 0700 "$cred_dir"
    # The host key only, not the TPM: a firmware or Secure Boot update can
    # change the TPM's measurements and lock a TPM-bound file for good.
    systemd-creds encrypt --with-key=host --name=sources "$source" "$cred.new"
    local back
    scratch; back="$REPLY"
    systemd-creds decrypt --name=sources "$cred.new" "$back"
    cmp -s "$source" "$back" || { rm -f "$cred.new"; die "the encrypted copy didn't read back; nothing was changed"; }
    chmod 0600 "$cred.new"
    rm -f "$cred.old"
    [[ -f "$cred" ]] && cp -p "$cred" "$cred.old"
    mv -f "$cred.new" "$cred"
    write_dropin "$(dropin_text)"
    if ! restart_and_check "$how"; then
      if [[ -f "$cred.old" ]]; then mv -f "$cred.old" "$cred"; else rm -f "$cred"; fi
      write_dropin "$previous_dropin"
      restart_and_check "$how" || true
      die "the collector didn't stay up with these sources, so they weren't kept (journalctl -u $collector)"
    fi
    rm -f "$cred.old"
    remove_plain
  else
    if [[ "$(mode)" == credential ]]; then
      install -o root -g root -m 0600 "$source" "$plain.new"
    else
      install -o root -g "$group" -m 0640 "$source" "$plain.new"
    fi
    mv -f "$plain.new" "$plain"
    write_dropin "$(dropin_text)"
    restart_and_check "$how" || die "the collector didn't stay up with these sources (journalctl -u $collector)"
  fi
}

case "${1:-}" in
  setup)
    remove_leftovers
    case "$(mode)" in
      encrypted)
        if [[ -f "$plain" && ! -f "$cred" ]]; then
          store "$plain" try-restart
          echo "Sources encrypted with systemd-creds: $cred"
        elif [[ -f "$cred" ]]; then
          if [[ -f "$plain" ]]; then
            echo "Both $cred and $plain exist; the collector uses the encrypted one." >&2
            echo "Remove $plain once you've checked (sources.sh show)." >&2
          fi
          write_dropin "$(dropin_text)"
          restart_and_check try-restart || die "the collector didn't stay up (journalctl -u $collector)"
          echo "Sources are encrypted: $cred"
        else
          die "no sources file at $plain or $cred"
        fi
        ;;
      credential)
        [[ -f "$plain" ]] || die "no sources file at $plain"
        store "$plain" try-restart
        echo "systemd-creds isn't available (systemd before 250), so $plain stays plain"
        echo "text, readable by root only, and reaches the collector in memory."
        ;;
      legacy)
        [[ -f "$plain" ]] || die "no sources file at $plain"
        store "$plain" try-restart
        echo "systemd is older than 247, so $plain stays plain text, readable by"
        echo "root and the service's group, as before."
        ;;
    esac
    ;;
  configure)
    scratch; file="$REPLY"
    python3 "$app/collectors.py" configure --output "$file"
    store "$file"
    echo "Sources saved; the collector has restarted with them."
    ;;
  edit)
    scratch; file="$REPLY"
    decrypt_to "$file"
    before="$(sha256sum < "$file")"
    read -ra editor <<< "${EDITOR:-$(command -v nano || command -v vi)}"
    "${editor[@]}" "$file"
    if [[ "$(sha256sum < "$file")" == "$before" ]]; then
      echo "No changes."
    else
      store "$file"
      echo "Sources saved; the collector has restarted with them."
    fi
    ;;
  show)
    scratch; file="$REPLY"
    decrypt_to "$file"
    if [[ -n "${2:-}" ]]; then
      [[ ! -e "$2" ]] || die "show: $2 already exists"
      install -m 0600 "$file" "$2"
      # Yours (not root's) when run with sudo, so you can copy it off.
      [[ -z "${SUDO_UID:-}" ]] || chown "$SUDO_UID:${SUDO_GID:-$SUDO_UID}" "$2"
      echo "Written to $2 (readable by you only). Delete it when you're done." >&2
    else
      cat "$file"
    fi
    ;;
  seal)
    [[ -n "${2:-}" && -f "$2" ]] || die "seal: pass the file to use"
    store "$2"
    echo "Sources saved from $2. It is still there in plain text: delete it when you're done."
    ;;
  *)
    awk 'NR > 1 && /^#/ { sub(/^# ?/, ""); print; next } NR > 1 { exit }' "$0"
    exit 1
    ;;
esac
