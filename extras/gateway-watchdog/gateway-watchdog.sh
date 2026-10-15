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

status=$(timeout 90 "$HERMES" gateway status 2>&1) || true
if ! grep -q "cannot serve this Hermes" <<<"$status"; then
  exit 0
fi
# an update may still be in progress (it holds a kernel lock on hermes-update.lock): try again later
INSTALL="${HERMES_INSTALL_DIR:-$HOME/.hermes/hermes-agent}"
for lock in "$INSTALL/.git/hermes-update.lock" "$INSTALL/.hermes-update.lock"; do
  if [ -e "$lock" ] && ! flock -n -s "$lock" true 2>/dev/null; then
    echo "gateway is outdated but an update is still running; retrying later"
    exit 0
  fi
done
echo "gateway is from an older Hermes: restarting it"
timeout 2400 "$HERMES" gateway restart
