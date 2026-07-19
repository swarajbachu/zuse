// E2B spike driver (issue #338). Stepwise subcommands, state in e2b-state.json:
//   node e2b-driver.mjs boot|capture|fork|verify|evidence|cleanup|status
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { Sandbox } from "e2b";

const STATE_FILE = new URL("./e2b-state.json", import.meta.url).pathname;
const state = existsSync(STATE_FILE) ? JSON.parse(readFileSync(STATE_FILE, "utf8")) : { timings: {} };
const save = () => writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
const now = () => Date.now();
const log = (...a) => console.log(new Date().toISOString(), ...a);
const TEMPLATE = "zuse-fork-spike";
const HOUR = 3_600_000;

async function sh(sbx, command, timeoutMs = 300_000) {
  const r = await sbx.commands.run(command, { timeoutMs });
  return r.stdout;
}

const cmd = process.argv[2];

if (cmd === "boot") {
  let t = now();
  const sbx = await Sandbox.create(TEMPLATE, { timeoutMs: 55 * 60_000, metadata: { spike: "338-source" } });
  state.sourceId = sbx.sandboxId;
  state.timings.bootMs = now() - t;
  log("source sandbox", sbx.sandboxId, "in", state.timings.bootMs, "ms");
  t = now();
  const out = await sh(sbx, "bash /opt/spike/e2b-start-workload.sh 2>&1 | tail -12", 300_000);
  state.timings.workloadStartMs = now() - t;
  log(out);
  state.sourceWebUrl = `https://${sbx.getHost(8787)}`;
  log("public dev-server:", state.sourceWebUrl);
  save();
} else if (cmd === "capture") {
  const sbx = await Sandbox.connect(state.sourceId);
  const out = await sh(sbx, "bash /opt/spike/invm/capture-state.sh >/dev/null && cat /opt/spike/state-before.json");
  state.stateBefore = JSON.parse(out);
  log(JSON.stringify(state.stateBefore, null, 2).slice(0, 1200));
  save();
} else if (cmd === "fork") {
  const sbx = await Sandbox.connect(state.sourceId);
  const probes = [];
  let probing = true;
  const prober = (async () => {
    while (probing) {
      const t0 = now();
      try {
        const res = await fetch(state.sourceWebUrl + "/health", { signal: AbortSignal.timeout(2000) });
        probes.push({ at: t0, ok: res.ok, ms: now() - t0 });
      } catch {
        probes.push({ at: t0, ok: false, ms: now() - t0 });
      }
      await new Promise((r) => setTimeout(r, 250));
    }
  })();
  let t = now();
  const snap = await sbx.createSnapshot({ name: "zuse-fork-spike-live" });
  state.timings.snapshotMs = now() - t;
  probing = false;
  await prober;
  state.snapshotId = snap.snapshotId;
  const gaps = probes.filter((p) => !p.ok);
  state.timings.sourceProbeFailures = gaps.length;
  state.timings.sourceInterruptionMs = gaps.length ? gaps.at(-1).at + gaps.at(-1).ms - gaps[0].at : 0;
  log("snapshot", snap.snapshotId, "in", state.timings.snapshotMs, "ms; source interruption ~", state.timings.sourceInterruptionMs, "ms over", gaps.length, "failed probes");
  // Fork: 10 concurrent creates from the snapshot.
  t = now();
  const results = await Promise.allSettled(
    Array.from({ length: 10 }, async (_, n) => {
      const t0 = now();
      const d = await Sandbox.create(snap.snapshotId, { timeoutMs: 55 * 60_000, metadata: { spike: `338-descendant-${n}` } });
      return { id: d.sandboxId, createMs: now() - t0 };
    }),
  );
  state.timings.forkAllMs = now() - t;
  state.descendants = results.filter((r) => r.status === "fulfilled").map((r) => r.value);
  state.forkErrors = results.filter((r) => r.status === "rejected").map((r) => String(r.reason).slice(0, 300));
  log("descendants:", state.descendants.length, "errors:", state.forkErrors.length, "total", state.timings.forkAllMs, "ms");
  state.descendants.forEach((d) => log(" ", d.id, d.createMs, "ms"));
  state.forkErrors.forEach((e) => log("  ERR", e));
  save();
} else if (cmd === "verify") {
  state.verify = {};
  state.timings.perDescendant = {};
  await Promise.allSettled(
    state.descendants.map(async ({ id }, n) => {
      const t0 = now();
      const sbx = await Sandbox.connect(id);
      await sh(sbx, "for i in $(seq 1 60); do curl -fsS http://127.0.0.1:8787/health >/dev/null 2>&1 && exit 0; sleep 1; done; exit 1", 90_000);
      const tHealthy = now() - t0;
      await sh(sbx, "for i in $(seq 1 60); do curl -fsS http://127.0.0.1:9222/json/version >/dev/null 2>&1 && exit 0; sleep 1; done; exit 1", 90_000);
      const tCdp = now() - t0;
      await sh(sbx, `bash /opt/spike/invm/verify-fork.sh e2b-${n} >/dev/null 2>&1 || true`, 240_000);
      const verdict = await sh(sbx, `cat /opt/spike/verify-e2b-${n}.json`, 60_000);
      state.timings.perDescendant[id] = { healthyMs: tHealthy, cdpMs: tCdp };
      state.verify[id] = JSON.parse(verdict.slice(verdict.lastIndexOf('{\n  "label"')));
      log(id, "healthy", tHealthy, "cdp", tCdp, "verdict", state.verify[id].verdict, JSON.stringify(state.verify[id].failed));
    }),
  ).then((rs) => rs.forEach((r, i) => r.status === "rejected" && log("descendant", state.descendants[i]?.id, "FAILED:", String(r.reason).slice(0, 400))));
  save();
} else if (cmd === "evidence") {
  const { id } = state.descendants[0];
  const sbx = await Sandbox.connect(id);
  let t = now();
  log(await sh(sbx, "bash /opt/spike/invm/record-evidence.sh 30 2>&1 | tail -5", 180_000));
  state.timings.evidenceRecordMs = now() - t;
  t = now();
  const bytes = await sbx.files.read("/opt/spike/evidence.mp4", { format: "bytes" });
  writeFileSync(new URL("./e2b-evidence.mp4", import.meta.url).pathname, Buffer.from(bytes));
  state.timings.evidenceShipMs = now() - t;
  state.timings.evidenceBytes = bytes.length;
  log("recorded", state.timings.evidenceRecordMs, "ms; shipped", bytes.length, "bytes in", state.timings.evidenceShipMs, "ms");
  save();
} else if (cmd === "cleanup") {
  const list = await Sandbox.list().nextItems();
  for (const s of list) {
    log("killing", s.sandboxId, s.metadata?.spike ?? "");
    await Sandbox.kill(s.sandboxId).catch((e) => log("kill failed", s.sandboxId, String(e).slice(0, 200)));
  }
  if (state.snapshotId) await Sandbox.deleteSnapshot(state.snapshotId).catch((e) => log("snapshot delete failed", String(e).slice(0, 200)));
  const after = await Sandbox.list().nextItems();
  log("post-cleanup sandboxes:", after.length);
} else if (cmd === "status") {
  log(JSON.stringify(state, null, 2));
  const list = await Sandbox.list().nextItems();
  log("live sandboxes:", list.map((s) => `${s.sandboxId}:${s.state ?? ""}`));
} else {
  console.log("usage: node e2b-driver.mjs boot|capture|fork|verify|evidence|cleanup|status");
  process.exit(1);
}
