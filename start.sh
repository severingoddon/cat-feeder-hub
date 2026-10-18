#!/usr/bin/env bash
# Startet mitmweb mit dem Oneisall-Capture-Addon.
set -euo pipefail
cd "$(dirname "$0")"

IP="$(ipconfig getifaddr en0 || ipconfig getifaddr en1 || echo '???')"
mkdir -p captures

echo "──────────────────────────────────────────────"
echo " iPhone → WLAN → (i) → HTTP-Proxy → Manuell"
echo "   Server: $IP"
echo "   Port:   8080"
echo " Zertifikat: auf dem iPhone in Safari http://mitm.it öffnen"
echo " Web-UI:     http://127.0.0.1:8081"
echo "──────────────────────────────────────────────"

exec .venv/bin/mitmweb \
  --listen-host 0.0.0.0 --listen-port 8080 \
  --web-port 8081 \
  -s addons/capture.py \
  -w "captures/raw-$(date +%Y%m%d-%H%M%S).mitm" \
  "$@"
