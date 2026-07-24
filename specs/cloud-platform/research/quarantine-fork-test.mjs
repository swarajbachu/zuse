// Verify: E2B can start a live-fork (create-from-snapshot) with networking
// blocked, and open it on command (ADR 0033 quarantine requirement).
import { Sandbox } from "e2b";

const log = (...a) => console.log(new Date().toISOString(), ...a);
const results = {};
const cleanup = { sandboxes: [], snapshotId: null };

// Egress probe from inside a sandbox: raw IP (no DNS) + domain, short timeouts.
async function probeEgress(sbx, label) {
	const ip = await sbx.commands.run(
		"curl -s -o /dev/null -m 6 -w '%{http_code}' https://1.1.1.1/ || echo FAIL",
		{ timeoutMs: 15_000 },
	);
	const dom = await sbx.commands.run(
		"curl -s -o /dev/null -m 6 -w '%{http_code}' https://example.com/ || echo FAIL",
		{ timeoutMs: 15_000 },
	);
	const out = { ip: ip.stdout.trim(), domain: dom.stdout.trim() };
	log(`egress[${label}]`, JSON.stringify(out));
	return out;
}

async function counterState(sbx) {
	const r = await sbx.commands.run(
		"cat /tmp/counter.txt 2>/dev/null; echo '|'; pgrep -f counter-loop | head -1; echo '|'; cut -d' ' -f22 /proc/$(pgrep -f counter-loop | head -1)/stat 2>/dev/null",
		{ timeoutMs: 10_000 },
	);
	const [count, pid, startTick] = r.stdout.split("|").map((s) => s.trim());
	return { count: Number(count), pid, startTick };
}

try {
	// 1. Source sandbox with a live stateful process.
	let t = Date.now();
	const src = await Sandbox.create("base", {
		timeoutMs: 30 * 60_000,
		metadata: { spike: "372-quarantine-src" },
	});
	cleanup.sandboxes.push(src.sandboxId);
	log("source created", src.sandboxId, Date.now() - t, "ms");

	await sbxWrite(src);
	const srcEgress = await probeEgress(src, "source");
	results.sourceEgress = srcEgress;
	const srcState = await counterState(src);
	log("source process", JSON.stringify(srcState));

	// 2. Live snapshot (no pause of source).
	t = Date.now();
	const snap = await src.createSnapshot({ name: "zuse-372-quarantine" });
	cleanup.snapshotId = snap.snapshotId;
	results.snapshotMs = Date.now() - t;
	log("snapshot", snap.snapshotId, results.snapshotMs, "ms");

	// 3a. QUARANTINED fork: allowInternetAccess: false at create-from-snapshot.
	t = Date.now();
	const fork = await Sandbox.create(snap.snapshotId, {
		timeoutMs: 30 * 60_000,
		allowInternetAccess: false,
		metadata: { spike: "372-quarantine-fork" },
	});
	cleanup.sandboxes.push(fork.sandboxId);
	results.forkCreateMs = Date.now() - t;
	log("quarantined fork created", fork.sandboxId, results.forkCreateMs, "ms");

	const forkState = await counterState(fork);
	results.processSurvived =
		forkState.pid === srcState.pid &&
		forkState.startTick === srcState.startTick &&
		forkState.count >= srcState.count;
	log(
		"fork process",
		JSON.stringify(forkState),
		"survived:",
		results.processSurvived,
	);

	results.quarantineEgress = await probeEgress(fork, "fork-quarantined");
	const c1 = await counterState(fork);
	await new Promise((r) => setTimeout(r, 3000));
	const c2 = await counterState(fork);
	results.processLiveInQuarantine = c2.count > c1.count && c2.pid === c1.pid;
	log(
		"process advancing inside quarantine:",
		results.processLiveInQuarantine,
		c1.count,
		"->",
		c2.count,
	);

	// 4. Open the network on command.
	t = Date.now();
	await fork.updateNetwork({ allowInternetAccess: true });
	results.openCommandMs = Date.now() - t;
	log("updateNetwork(open) returned in", results.openCommandMs, "ms");
	results.postOpenEgress = await probeEgress(fork, "fork-opened");

	// 5. Re-close (defense check: can we also re-block a running fork?)
	await fork.updateNetwork({ allowInternetAccess: false });
	results.recloseEgress = await probeEgress(fork, "fork-reclosed");

	// 6. Control fork: no flag — confirms quarantine came from the flag, not the snapshot.
	const ctrl = await Sandbox.create(snap.snapshotId, {
		timeoutMs: 10 * 60_000,
		metadata: { spike: "372-quarantine-ctrl" },
	});
	cleanup.sandboxes.push(ctrl.sandboxId);
	results.controlEgress = await probeEgress(ctrl, "fork-control");
} catch (e) {
	results.error = String(e?.stack ? e.stack : e).slice(0, 2000);
	log("ERROR", results.error);
} finally {
	for (const id of cleanup.sandboxes) {
		try {
			await Sandbox.kill(id);
			log("killed", id);
		} catch (e) {
			log("kill failed", id, String(e).slice(0, 200));
		}
	}
	if (cleanup.snapshotId) {
		try {
			await Sandbox.deleteSnapshot(cleanup.snapshotId);
			log("snapshot deleted");
		} catch (e) {
			log("snapshot delete failed", String(e).slice(0, 300));
		}
	}
	console.log(`RESULTS ${JSON.stringify(results, null, 2)}`);
}

async function sbxWrite(sbx) {
	// Live stateful process: counter loop with an in-memory increment + file mirror.
	await sbx.commands.run(
		`nohup bash -c 'exec -a counter-loop bash -c "n=0; while true; do n=$((n+1)); echo $n > /tmp/counter.txt; sleep 0.5; done"' >/dev/null 2>&1 &`,
		{ timeoutMs: 10_000 },
	);
	await new Promise((r) => setTimeout(r, 1500));
}
