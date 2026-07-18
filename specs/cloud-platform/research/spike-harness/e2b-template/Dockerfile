# E2B template for the zuse fork spike (issue #338): Debian 12 with the full
# workload pre-installed so sandbox startup only launches processes.
FROM debian:12

ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl ca-certificates xz-utils unzip ffmpeg xvfb procps sudo \
    libgtk-3-0 libnss3 libasound2 libxss1 libgbm1 libatk-bridge2.0-0 \
    libdrm2 libxkbcommon0 libxcomposite1 libxdamage1 libxrandr2 libcups2 \
    fonts-liberation \
  && rm -rf /var/lib/apt/lists/*

RUN mkdir -p /opt/spike/bin /opt/spike/logs /opt/spike/pids /opt/spike/watched /opt/spike/node

# Node 22 (matches the harness's node:sqlite requirement)
RUN curl -fsSL https://nodejs.org/dist/v22.17.0/node-v22.17.0-linux-x64.tar.xz \
  | tar -xJ --strip-components=1 -C /opt/spike/node

# chrome-headless-shell (Chrome for Testing, Stable pinned 2026-07-18)
RUN curl -fsSL -o /tmp/chs.zip "https://storage.googleapis.com/chrome-for-testing-public/151.0.7922.34/linux64/chrome-headless-shell-linux64.zip" \
  && unzip -q /tmp/chs.zip -d /opt/spike \
  && mv /opt/spike/chrome-headless-shell-linux64 /opt/spike/chrome-headless-shell \
  && rm /tmp/chs.zip

# cloudflared
RUN curl -fsSL -o /opt/spike/bin/cloudflared \
    https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64 \
  && chmod +x /opt/spike/bin/cloudflared

# Harness + Electron (npm install pulls the electron binary at build time)
COPY invm /opt/spike/invm
COPY e2b-start-workload.sh /opt/spike/e2b-start-workload.sh
RUN ln -sf /opt/spike/node/bin/node /usr/local/bin/node \
  && ln -sf /opt/spike/node/bin/npm /usr/local/bin/npm \
  && cd /opt/spike/invm/workload/electron-app \
  && npm install --no-audit --no-fund \
  && chmod +x /opt/spike/invm/*.sh /opt/spike/e2b-start-workload.sh \
  && chmod -R 777 /opt/spike
