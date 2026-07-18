#!/usr/bin/env bash
# Run on each descendant after the fork. Compares live state against
# /opt/spike/state-before.json and emits a JSON verdict per check to
# /opt/spike/verify-<label>.json (and stdout). Pass a label (descendant id).
set -euo pipefail
SPIKE=/opt/spike
LABEL=${1:-descendant}
export PATH="$SPIKE/bin:$SPIKE/node/bin:$PATH"

# Divergence probe: touch a file only this descendant sees; give the watcher
# and the sqlite writer a few seconds of post-fork runtime first.
sleep 5
MARKER="marker-$LABEL-$RANDOM"
touch "$SPIKE/watched/$MARKER"
sleep 2

node - "$SPIKE" "$LABEL" "$MARKER" <<'EOF' | tee "$SPIKE/verify-$LABEL.json"
const { execSync } = require("node:child_process");
const { readFileSync, existsSync } = require("node:fs");
const { DatabaseSync } = require("node:sqlite");
const [spike, label, marker] = process.argv.slice(2);
const before = JSON.parse(readFileSync(`${spike}/state-before.json`, "utf8"));
const sh = (c) => execSync(c, { encoding: "utf8" }).trim();
const checks = {};
const check = (name, fn) => { try { checks[name] = { pass: !!fn().pass, ...fn() }; } catch (e) { checks[name] = { pass: false, error: String(e) }; } };

// 1. Same processes alive, same start ticks => memory truly survived.
for (const [name, was] of Object.entries(before.pids)) {
  check(`process:${name}`, () => {
    if (!was) return { pass: false, note: "not captured pre-fork" };
    const alive = existsSync(`/proc/${was.pid}`);
    const startTicks = alive ? sh(`awk '{print $22}' /proc/${was.pid}/stat`) : null;
    return { pass: alive && startTicks === was.startTicks, alive, startTicks, was };
  });
}
// 2. SQLite handle still writing, no corruption, history advanced.
check("sqlite:advancing", () => {
  const db = new DatabaseSync(`${spike}/spike.db`, { readOnly: true });
  const integrity = db.prepare("PRAGMA integrity_check").get();
  const row = db.prepare("SELECT COUNT(*) AS n, MAX(id) AS maxId FROM ticks").get();
  return { pass: integrity.integrity_check === "ok" && row.maxId > before.sqlite.maxId, integrity: integrity.integrity_check, before: before.sqlite, now: row };
});
// 3. Divergence: rows written after fork carry this machine's boot id.
check("sqlite:diverged", () => {
  const bootId = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
  const db = new DatabaseSync(`${spike}/spike.db`, { readOnly: true });
  const post = db.prepare("SELECT COUNT(*) AS n FROM ticks WHERE id > ? AND boot_id = ?").get(before.sqlite.maxId, bootId);
  return { pass: post.n > 0, bootIdChanged: bootId !== before.bootId, bootId, postForkRows: post.n };
});
// 4. Watcher still observes changes (marker touched by this script).
check("watcher", () => {
  const events = JSON.parse(sh("curl -fsS http://127.0.0.1:8787/watch-events"));
  return { pass: events.some((e) => e.filename === marker), events: events.slice(-5) };
});
// 5. CDP endpoints answer.
check("cdp:chromium", () => ({ pass: !!JSON.parse(sh("curl -fsS http://127.0.0.1:9222/json/version")).Browser }));
check("cdp:electron", () => ({ pass: !!JSON.parse(sh("curl -fsS http://127.0.0.1:9223/json/version")).Browser }));
// 6. Tunnel: is the old connector re-registering or dead? (informational)
check("tunnel", () => {
  const tail = sh(`tail -5 ${spike}/logs/cloudflared.log`);
  return { pass: true, note: "manual judgement: does the pre-fork URL route to exactly one descendant?", tail };
});

const failed = Object.entries(checks).filter(([, c]) => !c.pass).map(([k]) => k);
console.log(JSON.stringify({ label, verdict: failed.length ? "FAIL" : "PASS", failed, checks }, null, 2));
EOF
