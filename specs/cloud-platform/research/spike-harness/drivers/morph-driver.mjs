// Morph Cloud spike driver (issue #338). Stepwise subcommands so a failed
// phase can be retried without rebooting the leg:
//   node morph-driver.mjs boot|setup|capture|fork|verify|evidence|cleanup|status
// State (ids, timings) persists in morph-state.json.
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { MorphCloudClient } from "morphcloud";

const HARNESS = process.env.HARNESS_DIR;
const STATE_FILE = new URL("./morph-state.json", import.meta.url).pathname;
const state = existsSync(STATE_FILE) ? JSON.parse(readFileSync(STATE_FILE, "utf8")) : { timings: {} };
const save = () => writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
const client = new MorphCloudClient({ apiKey: process.env.MORPH_API_KEY });
const now = () => Date.now();
const log = (...a) => console.log(new Date().toISOString(), ...a);

const cmd = process.argv[2];

async function sh(instance, command, timeout = 600) {
  const r = await instance.exec(command, { timeout });
  if (r.exit_code !== 0 && r.exitCode !== 0 && (r.exit_code ?? r.exitCode) !== undefined && (r.exit_code ?? r.exitCode) !== 0) {
    throw new Error(`exec failed (${r.exit_code ?? r.exitCode}): ${command}\n${r.stdout}\n${r.stderr}`);
  }
  return r.stdout ?? "";
}

if (cmd === "boot") {
  let t = now();
  const snapshot = await client.snapshots.create({ imageId: "morphvm-minimal", vcpus: 2, memory: 4096, diskSize: 20480 });
  state.baseSnapshotId = snapshot.id;
  state.timings.baseSnapshotCreateMs = now() - t;
  log("base snapshot", snapshot.id, state.timings.baseSnapshotCreateMs, "ms");
  t = now();
  const instance = await client.instances.start({ snapshotId: snapshot.id, ttlSeconds: 7200, ttlAction: "stop", metadata: { spike: "338-source" } });
  await instance.waitUntilReady(300);
  state.sourceInstanceId = instance.id;
  state.timings.bootToReadyMs = now() - t;
  log("source instance", instance.id, "ready in", state.timings.bootToReadyMs, "ms");
  const who = await sh(instance, "whoami; cat /etc/os-release | head -2; nproc; free -m | sed -n 2p; df -h / | tail -1");
  log(who);
  save();
} else if (cmd === "setup") {
  const instance = await client.instances.get({ instanceId: state.sourceInstanceId });
  // sudo shim for root-user minimal images (harness scripts call sudo).
  await sh(instance, "command -v sudo >/dev/null || { printf '#!/bin/sh\\nexec \"$@\"\\n' > /usr/local/bin/sudo && chmod +x /usr/local/bin/sudo; }");
  let t = now();
  await instance.sync(HARNESS + "/invm", "root@" + instance.id + ":/root/invm");
  log("harness uploaded in", now() - t, "ms");
  t = now();
  const out = await instance.exec("bash /root/invm/setup-workload.sh 2>&1 | tail -25", { timeout: 1800 });
  log("setup exit", out.exit_code ?? out.exitCode, "\n", out.stdout, out.stderr);
  state.timings.setupMs = now() - t;
  // expose dev server for source-interruption probing from the laptop
  const svc = await instance.exposeHttpService("web", 8787);
  state.sourceWebUrl = svc.url;
  log("exposed", svc.url);
  save();
} else if (cmd === "capture") {
  const instance = await client.instances.get({ instanceId: state.sourceInstanceId });
  const out = await sh(instance, "bash /root/invm/capture-state.sh && cat /opt/spike/state-before.json");
  log(out);
  save();
} else if (cmd === "fork") {
  const instance = await client.instances.get({ instanceId: state.sourceInstanceId });
  // Probe source availability at 250 ms while branching to measure interruption.
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
  const t = now();
  const { snapshot, instances } = await instance.branch(10);
  state.timings.branchTotalMs = now() - t;
  probing = false;
  await prober;
  state.forkSnapshotId = snapshot.id;
  state.descendants = instances.map((i) => i.id);
  const gaps = probes.filter((p) => !p.ok);
  state.timings.sourceProbeFailures = gaps.length;
  state.timings.sourceInterruptionMs = gaps.length ? (gaps.at(-1).at + gaps.at(-1).ms - gaps[0].at) : 0;
  log("branch(10) in", state.timings.branchTotalMs, "ms; snapshot", snapshot.id);
  log("descendants", state.descendants);
  log("source probe failures:", gaps.length, "interruption ~", state.timings.sourceInterruptionMs, "ms");
  save();
} else if (cmd === "verify") {
  state.verify = {};
  state.timings.perDescendant = {};
  const results = await Promise.allSettled(
    state.descendants.map(async (id, n) => {
      const t0 = now();
      const inst = await client.instances.get({ instanceId: id });
      await inst.waitUntilReady(300);
      const tReady = now() - t0;
      const health = now();
      await sh(inst, "for i in $(seq 1 60); do curl -fsS http://127.0.0.1:8787/health >/dev/null 2>&1 && exit 0; sleep 1; done; exit 1", 90);
      const tHealthy = now() - t0;
      await sh(inst, "for i in $(seq 1 60); do curl -fsS http://127.0.0.1:9222/json/version >/dev/null 2>&1 && exit 0; sleep 1; done; exit 1", 90);
      const tCdp = now() - t0;
      const verdict = await sh(inst, `bash /root/invm/verify-fork.sh morph-${n} 2>&1 | tail -40`, 180);
      state.timings.perDescendant[id] = { readyMs: tReady, healthyMs: tHealthy, cdpMs: tCdp };
      state.verify[id] = JSON.parse(verdict.slice(verdict.indexOf("{")));
      log(id, "ready", tReady, "healthy", tHealthy, "cdp", tCdp, "verdict", state.verify[id].verdict, state.verify[id].failed);
    }),
  );
  results.forEach((r, i) => r.status === "rejected" && log("descendant", state.descendants[i], "FAILED:", String(r.reason).slice(0, 500)));
  save();
} else if (cmd === "evidence") {
  const id = state.descendants[0];
  const inst = await client.instances.get({ instanceId: id });
  const t = now();
  await sh(inst, "bash /root/invm/record-evidence.sh 30", 120);
  state.timings.evidenceRecordMs = now() - t;
  const ssh = await inst.ssh();
  const t2 = now();
  await ssh.getFile(new URL("./morph-evidence.mp4", import.meta.url).pathname, "/opt/spike/evidence.mp4");
  ssh.dispose();
  state.timings.evidenceShipMs = now() - t2;
  log("evidence recorded", state.timings.evidenceRecordMs, "ms, shipped", state.timings.evidenceShipMs, "ms");
  save();
} else if (cmd === "cleanup") {
  const instances = await client.instances.list();
  for (const i of instances) {
    log("stopping", i.id);
    await i.stop().catch((e) => log("stop failed", i.id, String(e)));
  }
  const snaps = await client.snapshots.list();
  for (const s of snaps) {
    log("deleting snapshot", s.id);
    await s.delete().catch((e) => log("delete failed", s.id, String(e)));
  }
  log("post-cleanup instances:", (await client.instances.list()).length, "snapshots:", (await client.snapshots.list()).length);
} else if (cmd === "status") {
  log(JSON.stringify(state, null, 2));
  log("instances:", (await client.instances.list()).map((i) => `${i.id}:${i.status}`));
} else {
  console.log("usage: node morph-driver.mjs boot|setup|capture|fork|verify|evidence|cleanup|status");
  process.exit(1);
}
