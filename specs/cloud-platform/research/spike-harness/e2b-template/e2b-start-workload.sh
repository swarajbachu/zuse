#!/usr/bin/env bash
# E2B variant of setup-workload.sh's start phase: everything is pre-installed
# by the template Dockerfile, so this only launches the workload processes.
set -euo pipefail
SPIKE=/opt/spike
export PATH="$SPIKE/bin:$SPIKE/node/bin:$PATH"

start() {
  local name=$1; shift
  nohup "$@" >"$SPIKE/logs/$name.log" 2>&1 &
  echo $! >"$SPIKE/pids/$name.pid"
  echo "started $name pid $(cat "$SPIKE/pids/$name.pid")"
}

start sqlite-writer node "$SPIKE/invm/workload/sqlite-writer.mjs" "$SPIKE/spike.db"
start dev-server node "$SPIKE/invm/workload/dev-server.mjs" "$SPIKE/watched" 8787
start chromium "$SPIKE/chrome-headless-shell/chrome-headless-shell" \
  --remote-debugging-port=9222 --remote-debugging-address=127.0.0.1 \
  --no-sandbox --disable-gpu --user-data-dir="$SPIKE/chrome-profile" about:blank
start xvfb Xvfb :99 -screen 0 1440x900x24
sleep 2
DISPLAY=:99 start electron "$SPIKE/invm/workload/electron-app/node_modules/.bin/electron" \
  "$SPIKE/invm/workload/electron-app" --no-sandbox --remote-debugging-port=9223
start cloudflared "$SPIKE/bin/cloudflared" tunnel --url http://localhost:8787 --no-autoupdate

for i in $(seq 1 30); do
  curl -fsS http://127.0.0.1:9222/json/version >/dev/null 2>&1 \
    && curl -fsS http://127.0.0.1:9223/json/version >/dev/null 2>&1 \
    && curl -fsS http://127.0.0.1:8787/health >/dev/null 2>&1 && break
  sleep 1
done
echo "--- health ---"
curl -fsS http://127.0.0.1:9222/json/version >/dev/null && echo "chromium CDP ok"
curl -fsS http://127.0.0.1:9223/json/version >/dev/null && echo "electron CDP ok"
curl -fsS http://127.0.0.1:8787/health && echo " dev-server ok"
