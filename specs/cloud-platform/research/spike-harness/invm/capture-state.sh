#!/usr/bin/env bash
# Records the pre-snapshot identity of the machine and workload so
# verify-fork.sh can compare after the fork. Run immediately before the
# provider snapshot call.
set -euo pipefail
SPIKE=/opt/spike
export PATH="$SPIKE/bin:$SPIKE/node/bin:$PATH"

node - "$SPIKE" <<'EOF' >"$SPIKE/state-before.json"
const { execSync } = require("node:child_process");
const { readFileSync } = require("node:fs");
const { DatabaseSync } = require("node:sqlite");
const spike = process.argv[2];
const sh = (c) => execSync(c, { encoding: "utf8" }).trim();
const pids = {};
for (const name of ["sqlite-writer", "dev-server", "chromium", "xvfb", "electron", "cloudflared"]) {
  try {
    const pid = Number(readFileSync(`${spike}/pids/${name}.pid`, "utf8").trim());
    pids[name] = { pid, startTicks: sh(`awk '{print $22}' /proc/${pid}/stat`) };
  } catch { pids[name] = null; }
}
const db = new DatabaseSync(`${spike}/spike.db`, { readOnly: true });
const row = db.prepare("SELECT COUNT(*) AS n, MAX(id) AS maxId FROM ticks").get();
console.log(JSON.stringify({
  capturedAt: new Date().toISOString(),
  bootId: readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim(),
  machineId: readFileSync("/etc/machine-id", "utf8").trim(),
  hostname: sh("hostname"),
  monotonicMs: performance.now(),
  pids,
  sqlite: { rows: row.n, maxId: row.maxId },
  tunnelUrl: (() => { try { return sh(`grep -o 'https://[a-z0-9-]*\\.trycloudflare\\.com' ${spike}/logs/cloudflared.log | head -1`); } catch { return null; } })(),
  listeningPorts: sh("ss -ltnp | awk 'NR>1{print $4}'").split("\n"),
}, null, 2));
EOF
echo "wrote $SPIKE/state-before.json"
