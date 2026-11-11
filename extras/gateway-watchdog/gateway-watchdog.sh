#!/usr/bin/env bash
# Restart the Hermes gateway when a Hermes update left the old one running.
#
# After `hermes update` (or a WebUI update) the running gateway keeps the old code, and
# `hermes gateway status` reports that it "cannot serve this Hermes": cron jobs then fail with
# "GatewayUnavailableError: Gateway incompatible" until someone restarts it. Run every 10 minutes
# by hermes-gateway-watchdog.timer; does nothing while the gateway matches the installed Hermes.
# The restart is Hermes' own graceful one: it waits for running turns to finish.
set -u
HERMES="${HERMES_BIN:-$HOME/.local/bin/hermes}"
INSTALL="${HERMES_INSTALL_DIR:-$HOME/.hermes/hermes-agent}"
UNIT="${HERMES_GATEWAY_UNIT:-hermes-gateway}"
STAMP="${XDG_RUNTIME_DIR:-${TMPDIR:-/tmp}}/hermes-gateway-watchdog.checked"

# `hermes gateway status` loads all of Hermes (seconds of CPU, and it logs warnings), so ask it only
# when something changed since the last good answer: the checkout moved (git appends to
# .git/logs/HEAD on every pull), the gateway (re)started, or a new day began. Without a readable
# checkout marker there is no shortcut and every run asks.
head=$(stat -c %Y "$INSTALL/.git/logs/HEAD" 2>/dev/null)
started=$(systemctl --user show "$UNIT" -p ActiveEnterTimestampMonotonic --value 2>/dev/null)
key="$(date +%F) $head $started"
if [ -n "$head" ] && [ "$(cat "$STAMP" 2>/dev/null)" = "$key" ]; then
  exit 0
fi

status=$(timeout 90 "$HERMES" gateway status 2>&1)
answered=$?
if ! grep -q "cannot serve this Hermes" <<<"$status"; then
  # remember a real answer only: a status that failed or timed out is asked again next time
  if [ "$answered" -eq 0 ]; then printf '%s' "$key" >"$STAMP" 2>/dev/null; fi
  exit 0
fi
# an update may still be in progress (it holds a kernel lock on hermes-update.lock): try again later
for lock in "$INSTALL/.git/hermes-update.lock" "$INSTALL/.hermes-update.lock"; do
  if [ -e "$lock" ] && ! flock -n -s "$lock" true 2>/dev/null; then
    echo "gateway is outdated but an update is still running; retrying later"
    exit 0
  fi
done
echo "gateway is from an older Hermes: restarting it"
timeout 2400 "$HERMES" gateway restart
