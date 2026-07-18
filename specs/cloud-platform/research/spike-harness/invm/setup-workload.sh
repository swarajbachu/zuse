#!/usr/bin/env bash
# Installs dependencies and starts the full target workload on a fresh
# Ubuntu/Debian machine. Everything lives under /opt/spike; each process
# writes a pidfile so capture/verify scripts can reason about identity.
set -euo pipefail

SPIKE=/opt/spike
NODE_VERSION=22.17.0
CHROME_CDP_PORT=9222
ELECTRON_CDP_PORT=9223
DISPLAY_NUM=99

sudo mkdir -p "$SPIKE" && sudo chown "$(id -u):$(id -g)" "$SPIKE"
cd "$SPIKE"
mkdir -p bin logs pids watched

export DEBIAN_FRONTEND=noninteractive
sudo apt-get update -y
# Xvfb + Electron runtime deps + capture + tunnel prerequisites.
sudo apt-get install -y --no-install-recommends \
  curl ca-certificates xz-utils unzip ffmpeg xvfb \
  libgtk-3-0 libnss3 libxss1 libgbm1 libatk-bridge2.0-0 \
  libdrm2 libxkbcommon0 libxcomposite1 libxdamage1 libxrandr2 libcups2 \
  fonts-liberation
# libasound2 was renamed libasound2t64 on Ubuntu 24.04+.
sudo apt-get install -y --no-install-recommends libasound2 \
  || sudo apt-get install -y --no-install-recommends libasound2t64

# Node (tarball install: identical on Ubuntu and Debian, no snap).
if [ ! -x "$SPIKE/node/bin/node" ]; then
  arch=$(uname -m); [ "$arch" = "aarch64" ] && narch=arm64 || narch=x64
  mkdir -p "$SPIKE/node"
  curl -fsSL "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-${narch}.tar.xz" \
    | tar -xJ --strip-components=1 -C "$SPIKE/node"
fi
export PATH="$SPIKE/bin:$SPIKE/node/bin:$PATH"

# chrome-headless-shell via Chrome for Testing (no snap dependency).
if [ ! -d "$SPIKE/chrome-headless-shell" ]; then
  arch=$(uname -m); [ "$arch" = "aarch64" ] && carch=linux-arm64 || carch=linux64
  cdp_ver=$(curl -fsSL https://googlechromelabs.github.io/chrome-for-testing/last-known-good-versions.json | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>console.log(JSON.parse(d).channels.Stable.version))')
  curl -fsSL -o /tmp/chs.zip "https://storage.googleapis.com/chrome-for-testing-public/${cdp_ver}/${carch}/chrome-headless-shell-${carch}.zip"
  unzip -q /tmp/chs.zip -d "$SPIKE" && mv "$SPIKE/chrome-headless-shell-${carch}" "$SPIKE/chrome-headless-shell"
fi

# cloudflared (quick tunnel; no account needed for the trycloudflare URL).
if [ ! -x "$SPIKE/bin/cloudflared" ]; then
  arch=$(uname -m); [ "$arch" = "aarch64" ] && tarch=arm64 || tarch=amd64
  curl -fsSL -o "$SPIKE/bin/cloudflared" "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-${tarch}"
  chmod +x "$SPIKE/bin/cloudflared"
fi

# Electron app (downloads the matching electron binary via npm).
cp -r "$(dirname "$0")/workload" "$SPIKE/workload-src" 2>/dev/null || true
cd "$SPIKE/workload-src/electron-app" && npm install --no-audit --no-fund && cd "$SPIKE"

start() { # name, command...
  local name=$1; shift
  nohup "$@" >"$SPIKE/logs/$name.log" 2>&1 &
  echo $! >"$SPIKE/pids/$name.pid"
  echo "started $name pid $(cat "$SPIKE/pids/$name.pid")"
}

start sqlite-writer node "$SPIKE/workload-src/sqlite-writer.mjs" "$SPIKE/spike.db"
start dev-server node "$SPIKE/workload-src/dev-server.mjs" "$SPIKE/watched" 8787
start chromium "$SPIKE/chrome-headless-shell/chrome-headless-shell" \
  --remote-debugging-port=$CHROME_CDP_PORT --remote-debugging-address=127.0.0.1 \
  --no-sandbox --disable-gpu --user-data-dir="$SPIKE/chrome-profile" about:blank
start xvfb Xvfb ":$DISPLAY_NUM" -screen 0 1440x900x24
sleep 2
DISPLAY=":$DISPLAY_NUM" start electron "$SPIKE/workload-src/electron-app/node_modules/.bin/electron" \
  "$SPIKE/workload-src/electron-app" --no-sandbox --remote-debugging-port=$ELECTRON_CDP_PORT
start cloudflared "$SPIKE/bin/cloudflared" tunnel --url http://localhost:8787 --no-autoupdate

sleep 5
echo "--- health ---"
curl -fsS "http://127.0.0.1:$CHROME_CDP_PORT/json/version" >/dev/null && echo "chromium CDP ok"
curl -fsS "http://127.0.0.1:$ELECTRON_CDP_PORT/json/version" >/dev/null && echo "electron CDP ok"
curl -fsS "http://127.0.0.1:8787/health" && echo " dev-server ok"
grep -o 'https://[a-z0-9-]*\.trycloudflare\.com' "$SPIKE/logs/cloudflared.log" | head -1 || echo "tunnel URL pending (see logs/cloudflared.log)"
echo "workload up; run capture-state.sh before snapshotting"
