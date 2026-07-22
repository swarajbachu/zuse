import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
	devInstanceDiagnostics,
	initialDevInstance,
	parseDevArguments,
	reserveDevPortPair,
	withScannedPorts,
} from "./dev-instance.mjs";

test("parses named and dry-run development arguments", () => {
	assert.deepEqual(parseDevArguments(["--instance", "review", "--dry-run"]), {
		instance: "review",
		dryRun: true,
	});
});

test("named instances produce deterministic isolated resources", () => {
	const first = initialDevInstance({
		argv: ["--instance", "review"],
		env: {},
		repoRoot: "/workspace",
	});
	const second = initialDevInstance({
		argv: [],
		env: { ZUSE_DEV_INSTANCE: "review" },
		repoRoot: "/workspace",
	});
	assert.equal(first.rendererPort, second.rendererPort);
	assert.equal(first.websocketPort, second.websocketPort);
	assert.match(first.userDataDir, /review\/user-data$/u);
	assert.match(first.packDir, /review\/dist-electron$/u);
});

test("the first unnamed instance preserves the existing development profile", () => {
	const instance = initialDevInstance({
		argv: [],
		env: {},
		repoRoot: "/workspace",
	});
	assert.equal(instance.rendererPort, 5733);
	assert.equal(instance.websocketPort, 8788);
	assert.equal(instance.userDataDir, undefined);
	assert.match(instance.packDir, /default\/dist-electron$/u);
	assert.equal(
		devInstanceDiagnostics(instance).dataDirectory,
		"Electron default (existing Zuse Alpha (Dev) profile)",
	);
});

test("explicit offsets and ports remain authoritative", () => {
	const offset = initialDevInstance({
		argv: ["--instance", "offset"],
		env: { ZUSE_PORT_OFFSET: "40" },
		repoRoot: "/workspace",
	});
	assert.equal(offset.rendererPort, 5773);
	assert.equal(offset.websocketPort, 8828);

	const explicit = initialDevInstance({
		argv: ["--instance", "explicit"],
		env: { PORT: "6200", ZUSE_DESKTOP_WS_PORT: "9200" },
		repoRoot: "/workspace",
	});
	assert.equal(explicit.rendererPort, 6200);
	assert.equal(explicit.websocketPort, 9200);

	const explicitData = initialDevInstance({
		argv: [],
		env: { ZUSE_USER_DATA_DIR: "/existing/dev-profile" },
		repoRoot: "/workspace",
	});
	assert.equal(explicitData.userDataDir, "/existing/dev-profile");
});

test("scans paired ports forward and fails occupied explicit overrides", async () => {
	const initial = initialDevInstance({
		argv: ["--instance", "scan"],
		env: { ZUSE_PORT_OFFSET: "0" },
		repoRoot: "/workspace",
	});
	const occupied = new Set([5733, 5734, 8788, 8789]);
	const scanned = await withScannedPorts(
		initial,
		async (port) => !occupied.has(port),
	);
	assert.equal(scanned.rendererPort, 5735);
	assert.equal(scanned.websocketPort, 8790);
	assert.equal(scanned.userDataDir, initial.userDataDir);
	assert.match(scanned.packDir, /scan-p5735\/dist-electron$/u);

	const explicit = initialDevInstance({
		argv: ["--instance", "busy"],
		env: { PORT: "6200", ZUSE_DESKTOP_WS_PORT: "9200" },
		repoRoot: "/workspace",
	});
	await assert.rejects(
		withScannedPorts(explicit, async () => false),
		/explicit renderer 6200 and websocket 9200 port is unavailable/u,
	);
});

test("automatic scans preserve the existing development profile", async () => {
	const initial = initialDevInstance({
		argv: [],
		env: {},
		repoRoot: "/workspace",
	});
	const scanned = await withScannedPorts(
		initial,
		async (port) => port !== 5733 && port !== 8788,
	);
	assert.equal(scanned.instance, "port-5734");
	assert.equal(scanned.userDataDir, initial.userDataDir);
	assert.match(scanned.packDir, /port-5734\/dist-electron$/u);
});

test("atomically reserves a pair and scans past a concurrent runner", async () => {
	const repoRoot = await mkdtemp(join(tmpdir(), "zuse-dev-lock-"));
	const initial = initialDevInstance({
		argv: [],
		env: {},
		repoRoot,
	});
	const first = reserveDevPortPair(repoRoot, 5733, 8788);
	assert.equal(typeof first, "function");
	assert.equal(reserveDevPortPair(repoRoot, 5733, 8788), null);
	const scanned = await withScannedPorts(
		initial,
		async () => true,
		(rendererPort, websocketPort) =>
			reserveDevPortPair(repoRoot, rendererPort, websocketPort),
	);
	assert.equal(scanned.rendererPort, 5734);
	assert.equal(scanned.websocketPort, 8789);
	scanned.releaseReservation();
	first?.();
});

test("dry-run diagnostics contain every isolated resource", () => {
	const instance = initialDevInstance({
		argv: ["--instance", "diagnostic", "--dry-run"],
		env: { ZUSE_PORT_OFFSET: "1" },
		repoRoot: "/workspace",
	});
	assert.deepEqual(devInstanceDiagnostics(instance), {
		instance: "diagnostic",
		rendererPort: 5734,
		websocketPort: 8789,
		rendererUrl: "http://localhost:5734",
		dataDirectory: "/workspace/.zuse/dev-instances/diagnostic/user-data",
		packDirectory:
			"/workspace/apps/desktop/.dev-instances/diagnostic/dist-electron",
	});
});
