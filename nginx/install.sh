#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SRC="$SCRIPT_DIR/lark-h5-bug-bot-proxy.conf"
DST="/etc/nginx/snippets/lark-h5-bug-bot-proxy.conf"
DEFAULT_SITE="/etc/nginx/sites-enabled/default"
INCLUDE_LINE="include snippets/lark-h5-bug-bot-proxy.conf;"

# Copy proxy config
cp "$SRC" "$DST"
echo "Copied $SRC -> $DST"

# Add include to default site if not already present
if grep -qF "$INCLUDE_LINE" "$DEFAULT_SITE"; then
  echo "Include already present in $DEFAULT_SITE"
else
  sed -i "/^[[:space:]]*location \/ {/i\\	$INCLUDE_LINE" "$DEFAULT_SITE"
  echo "Added include to $DEFAULT_SITE"
fi

# Test and reload
nginx -t && systemctl reload nginx && echo "Nginx reloaded successfully"
