// Focused rerun: does a live process keep advancing INSIDE the network quarantine?
import { Sandbox } from "e2b";

const log = (...a) => console.log(new Date().toISOString(), ...a);
const cleanup = { sandboxes: [], snapshotId: null };
const results = {};

const count = async (sbx) =>
	Number(
		(
			await sbx.commands.run("cat /tmp/counter.txt 2>/dev/null || echo 0", {
				timeoutMs: 10_000,
			})
		).stdout.trim() || 0,
	);

try {
	const src = await Sandbox.create("base", {
		timeoutMs: 15 * 60_000,
		metadata: { spike: "372-liveness-src" },
	});
	cleanup.sandboxes.push(src.sandboxId);
	await src.files.write(
		"/tmp/loop.sh",
		"#!/bin/bash\nn=0\nwhile true; do n=$((n+1)); echo $n > /tmp/counter.txt; sleep 0.4; done\n",
	);
	await src.commands.run("chmod +x /tmp/loop.sh", { timeoutMs: 10_000 });
	await src.commands.run("/tmp/loop.sh", { background: true });
	await new Promise((r) => setTimeout(r, 1500));
	const s1 = await count(src);
	await new Promise((r) => setTimeout(r, 2000));
	const s2 = await count(src);
	results.sourceAdvancing = s2 > s1;
	log("source advancing", s1, "->", s2);
	if (!results.sourceAdvancing)
		throw new Error("source loop not running; aborting");

	const snap = await src.createSnapshot({ name: "zuse-372-liveness" });
	cleanup.snapshotId = snap.snapshotId;
	const fork = await Sandbox.create(snap.snapshotId, {
		timeoutMs: 15 * 60_000,
		allowInternetAccess: false,
		metadata: { spike: "372-liveness-fork" },
	});
	cleanup.sandboxes.push(fork.sandboxId);
	const egress = (
		await fork.commands.run(
			"curl -s -o /dev/null -m 5 -w '%{http_code}' https://1.1.1.1/ || echo FAIL",
			{ timeoutMs: 12_000 },
		)
	).stdout.trim();
	const f1 = await count(fork);
	await new Promise((r) => setTimeout(r, 2500));
	const f2 = await count(fork);
	results.quarantineEgress = egress;
	results.forkAdvancingInQuarantine = f2 > f1;
	log("fork egress:", egress, "| fork advancing in quarantine:", f1, "->", f2);
} catch (e) {
	results.error = String(e).slice(0, 800);
	log("ERROR", results.error);
} finally {
	for (const id of cleanup.sandboxes) {
		try {
			await Sandbox.kill(id);
		} catch {}
	}
	if (cleanup.snapshotId) {
		try {
			await Sandbox.deleteSnapshot(cleanup.snapshotId);
		} catch {}
	}
	console.log(`RESULTS ${JSON.stringify(results)}`);
}
