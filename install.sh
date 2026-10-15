#!/usr/bin/env bash
# Install or update Bot Hub on the machine that runs Hermes and Hermes WebUI:
# the sidecar (systemd user service) and the WebUI extension.
#
#   bash install.sh               sidecar + extension
#   bash install.sh --with-team   also copy the bothub-team plugin (bot-to-bot questions)
#
# Settings (environment): HERMES_HOME (~/.hermes), HERMES_WEBUI_STATE_DIR ($HERMES_HOME/webui),
# BOT_HUB_PORT (17790), BOT_HUB_PYTHON (python3 with PyYAML), HERMES_BIN (hermes on PATH).
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
HERMES_HOME="${HERMES_HOME:-$HOME/.hermes}"
STATE_DIR="${HERMES_WEBUI_STATE_DIR:-$HERMES_HOME/webui}"
EXT_DIR="$STATE_DIR/extensions/bot-hub"
PORT="${BOT_HUB_PORT:-17790}"
VERSION="2.1.0"
WITH_TEAM=0
for arg in "$@"; do
  case "$arg" in
    --with-team) WITH_TEAM=1 ;;
    -h|--help) sed -n '2,9p' "$0"; exit 0 ;;
    *) echo "unknown option: $arg" >&2; exit 2 ;;
  esac
done

# A python3 with PyYAML; /usr/bin/python3 first, so Hermes updates never pull it away.
PY="${BOT_HUB_PYTHON:-}"
if [ -z "$PY" ]; then
  for candidate in /usr/bin/python3 "$(command -v python3 || true)"; do
    if [ -n "$candidate" ] && [ -x "$candidate" ] && "$candidate" -I -c 'import yaml' 2>/dev/null; then
      PY="$candidate"; break
    fi
  done
fi
if [ -z "$PY" ] || ! "$PY" -I -c 'import yaml' 2>/dev/null; then
  echo "✗ no python3 with PyYAML found. Install it (Debian/Ubuntu: sudo apt install python3-yaml)" >&2
  echo "  or point BOT_HUB_PYTHON at one." >&2
  exit 1
fi
HERMES_BIN="${HERMES_BIN:-$(command -v hermes || echo "$HOME/.local/bin/hermes")}"
[ -x "$HERMES_BIN" ] || echo "⚠ hermes not found at $HERMES_BIN (set HERMES_BIN): routines and edits will fail"
[ -d "$STATE_DIR" ] || echo "⚠ no Hermes WebUI state directory at $STATE_DIR (set HERMES_WEBUI_STATE_DIR)"

echo "→ sidecar ($PY, port $PORT)"
mkdir -p "$HERMES_HOME/bot-hub" "$HOME/.config/systemd/user"
install -m 644 "$HERE/sidecar/bot_hub_sidecar.py" "$HERMES_HOME/bot-hub/bot_hub_sidecar.py"
if [ ! -e "$HERMES_HOME/bot-hub/config.json" ]; then
  install -m 600 "$HERE/config.example.json" "$HERMES_HOME/bot-hub/config.json"
  echo "  created $HERMES_HOME/bot-hub/config.json (voice off; see README to turn it on)"
fi
sed -e "s|@HERMES_HOME@|$HERMES_HOME|g" -e "s|@PORT@|$PORT|g" -e "s|@PYTHON@|$PY|g" -e "s|@HERMES_BIN@|$HERMES_BIN|g" \
  "$HERE/sidecar/bot-hub-sidecar.service" > "$HOME/.config/systemd/user/bot-hub-sidecar.service"
systemctl --user daemon-reload
systemctl --user enable bot-hub-sidecar.service >/dev/null
systemctl --user restart bot-hub-sidecar.service

echo "→ WebUI extension ($EXT_DIR)"
mkdir -p "$EXT_DIR"
for f in bot-hub.js bot-hub.css; do
  install -m 644 "$HERE/extension/$f" "$EXT_DIR/$f"
done
sed -e "s|http://127.0.0.1:17790|http://127.0.0.1:$PORT|" "$HERE/extension/manifest.json" > "$EXT_DIR/manifest.json"

"$PY" -I - "$STATE_DIR/extension-install-manifest.json" "$VERSION" <<'PY'
import json, os, sys, datetime
path, version = sys.argv[1], sys.argv[2]
try:
    with open(path, encoding="utf-8") as fh:
        data = json.load(fh)
    if not isinstance(data, dict) or not isinstance(data.get("installed"), dict):
        raise ValueError
except (OSError, ValueError):
    data = {"version": 1, "installed": {}}
data["installed"]["bot-hub"] = {
    "version": version,
    "files": ["manifest.json", "bot-hub.js", "bot-hub.css"],
    "installed_at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
}
tmp = path + ".tmp"
with open(tmp, "w", encoding="utf-8") as fh:
    json.dump(data, fh, indent=2)
os.replace(tmp, path)
PY

if [ "$WITH_TEAM" = 1 ]; then
  echo "→ bothub-team plugin ($HERMES_HOME/plugins/bothub-team)"
  mkdir -p "$HERMES_HOME/plugins/bothub-team"
  install -m 644 "$HERE/hermes-plugin/bothub-team/__init__.py" "$HERE/hermes-plugin/bothub-team/plugin.yaml" \
    "$HERMES_HOME/plugins/bothub-team/"
  echo "  enable it for each bot (see README, \"Bots asking each other\")."
fi

for i in 1 2 3 4 5; do
  curl -fsS -m 2 "http://127.0.0.1:$PORT/health" >/dev/null 2>&1 && break
  sleep 1
done
if curl -fsS -m 2 "http://127.0.0.1:$PORT/health" >/dev/null; then
  echo "✓ sidecar running (127.0.0.1:$PORT)"
else
  echo "✗ sidecar not answering: journalctl --user -u bot-hub-sidecar"
fi
echo "✓ extension installed — reload the WebUI (F5), then allow Bot Hub's sidecar when asked."
