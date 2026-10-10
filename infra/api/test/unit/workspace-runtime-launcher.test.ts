import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0))
		rmSync(root, { recursive: true, force: true });
});

const fixture = () => {
	const root = mkdtempSync(join(tmpdir(), "zuse-launcher-storage-"));
	roots.push(root);
	const canonical = join(root, "canonical");
	const legacy = join(root, "legacy");
	const persisted = join(root, "persisted");
	const status = join(root, "status");
	// Execute the production shell logic, relocating only the sandbox's absolute
	// candidate paths. No fixture writes /var/lib, /home/zuse, or /srv/zuse.
	const source = readFileSync(
		new URL("../../../cloud-sandboxes/workspace-runtime.sh", import.meta.url),
		"utf8",
	)
		.replaceAll("/var/lib/zuse/user-data", canonical)
		.replaceAll("/home/zuse/.zuse-data", legacy)
		.replaceAll("/srv/zuse/home/.zuse-data", persisted);
	const env = {
		...process.env,
		ZUSE_USER_DATA: canonical,
		ZUSE_WORKSPACE_RUNTIME_STATUS_DIR: status,
		ZUSE_RUNTIME_GENERATION: "7",
		ZUSE_WORKSPACE_RUNTIME_LOCK_FD: "",
	};
	const run = (extraEnv: Record<string, string> = {}) =>
		spawnSync(
			"bash",
			[
				"-c",
				`set -euo pipefail\n${source}\ninitialize_workspace_runtime_attempt\nacquire_workspace_runtime_lock\nprintf '%s\\n' "$ZUSE_USER_DATA"`,
			],
			{
				env: { ...env, ...extraEnv },
				encoding: "utf8",
			},
		);
	const populate = (directory: string, contents = "original database") => {
		mkdirSync(directory);
		writeFileSync(join(directory, "zuse.sqlite"), contents);
		writeFileSync(join(directory, "zuse.sqlite-wal"), "uncheckpointed WAL");
	};
	const failurePhases = () =>
		readdirSync(join(status, "attempts")).map((attempt) =>
			readFileSync(
				join(status, "attempts", attempt, "failure-phase"),
				"utf8",
			).trim(),
		);
	return {
		root,
		canonical,
		legacy,
		persisted,
		status,
		source,
		env,
		run,
		populate,
		failurePhases,
	};
};

test("distinct populated database roots fail before choosing or mutating either store", () => {
	const f = fixture();
	f.populate(f.canonical, "canonical database");
	f.populate(f.legacy, "legacy database");
	const result = f.run();
	expect(result.status, result.stderr).toBe(74);
	expect(f.failurePhases()).toEqual(["runtime-storage-ambiguous"]);
	for (const [directory, data] of [
		[f.canonical, "canonical database"],
		[f.legacy, "legacy database"],
	] as const) {
		expect(readFileSync(join(directory, "zuse.sqlite"), "utf8")).toBe(data);
		expect(readFileSync(join(directory, "zuse.sqlite-wal"), "utf8")).toBe(
			"uncheckpointed WAL",
		);
		expect(existsSync(join(directory, ".workspace-runtime.lock"))).toBe(false);
	}
	expect(existsSync(join(f.status, "failed"))).toBe(false);
});

test("same-inode aliases resolve to the retained store without moving its database or WAL", () => {
	const f = fixture();
	f.populate(f.persisted);
	symlinkSync(f.persisted, f.canonical);
	symlinkSync(f.persisted, f.legacy);
	const result = f.run({ ZUSE_RUNTIME_EXPECT_EXISTING_DATA: "1" });
	expect(result.status, result.stderr).toBe(0);
	expect(result.stdout.trim()).toBe(f.persisted);
	expect(readFileSync(join(f.persisted, "zuse.sqlite"), "utf8")).toBe(
		"original database",
	);
	expect(readFileSync(join(f.persisted, "zuse.sqlite-wal"), "utf8")).toBe(
		"uncheckpointed WAL",
	);
});

test("a missing retained database fails without initializing an empty replacement", () => {
	const f = fixture();
	const result = f.run({ ZUSE_RUNTIME_EXPECT_EXISTING_DATA: "1" });
	expect(result.status, result.stderr).toBe(74);
	expect(f.failurePhases()).toEqual(["runtime-storage-missing"]);
	for (const candidate of [f.canonical, f.legacy, f.persisted])
		expect(existsSync(candidate)).toBe(false);
	expect(existsSync(join(f.status, "failed"))).toBe(false);
});

test("an alias contender cannot enter storage or poison the existing owner's readiness", async () => {
	const f = fixture();
	f.populate(f.persisted);
	symlinkSync(f.persisted, f.canonical);
	symlinkSync(f.persisted, f.legacy);
	mkdirSync(f.status);
	writeFileSync(join(f.status, "ready"), "owner ready");
	const entered = join(f.root, "entered");
	const owner = spawn(
		"bash",
		[
			"-c",
			`set -euo pipefail\n${f.source}\ninitialize_workspace_runtime_attempt\nexec_workspace_runtime "$1" -e "$2" "$3"`,
			"launcher",
			process.execPath,
			`require('node:fs').writeFileSync(process.argv[1],process.env.ZUSE_USER_DATA);setInterval(()=>{},1000)`,
			entered,
		],
		{
			env: f.env,
			stdio: "ignore",
		},
	);
	const exited = once(owner, "exit");
	try {
		await vi.waitFor(() => expect(existsSync(entered)).toBe(true));
		expect(readFileSync(entered, "utf8")).toBe(f.persisted);
		const contender = f.run({
			ZUSE_USER_DATA: f.legacy,
			ZUSE_RUNTIME_GENERATION: "8",
		});
		expect(contender.status, contender.stderr).toBe(75);
		expect(readFileSync(join(f.status, "ready"), "utf8")).toBe("owner ready");
		expect(existsSync(join(f.status, "failed"))).toBe(false);
		expect(readFileSync(join(f.persisted, "zuse.sqlite-wal"), "utf8")).toBe(
			"uncheckpointed WAL",
		);
	} finally {
		owner.kill("SIGTERM");
		await exited;
	}
	expect(f.run().status).toBe(0);
});

test("bootstrap loads native snapshot paths before selecting and locking storage", () => {
	const f = fixture();
	const native = join(f.root, "native-data");
	f.populate(native);
	const launcher = join(f.root, "workspace-runtime.sh");
	writeFileSync(launcher, f.source);
	const snapshot = join(f.root, "snapshot.env");
	writeFileSync(snapshot, `export ZUSE_USER_DATA='${native}'\n`);
	const bootstrap = readFileSync(
		new URL("../../../cloud-sandboxes/workspace-bootstrap.sh", import.meta.url),
		"utf8",
	);
	const boundary = bootstrap.indexOf("\nworkspace=");
	expect(boundary).toBeGreaterThan(0);
	// Execute the real bootstrap prefix through lock acquisition. Later SSH,
	// runtime, and repository actions are outside this storage-ordering test.
	const prefix = bootstrap
		.slice(0, boundary)
		.replaceAll("/var/lib/zuse/workspace", f.status)
		.replaceAll("/var/lib/zuse/project-build/workspace-runtime.sh", launcher)
		.replaceAll("/usr/local/lib/zuse/workspace-runtime.sh", launcher)
		.replaceAll("/etc/zuse/snapshot.env", snapshot);
	const result = spawnSync(
		"bash",
		[
			"-c",
			`${prefix}\nprintf '%s\\n' "$ZUSE_USER_DATA"; readlink -f "/proc/$$/fd/$ZUSE_WORKSPACE_RUNTIME_LOCK_FD"`,
		],
		{
			env: {
				...f.env,
				ZUSE_SNAPSHOT_NATIVE: "1",
				ZUSE_RUNTIME_EXPECT_EXISTING_DATA: "1",
			},
			encoding: "utf8",
		},
	);
	expect(result.status, result.stderr).toBe(0);
	expect(result.stdout.trim().split("\n")).toEqual([
		native,
		join(native, ".workspace-runtime.lock"),
	]);
	expect(existsSync(f.canonical)).toBe(false);
	expect(readFileSync(join(native, "zuse.sqlite-wal"), "utf8")).toBe(
		"uncheckpointed WAL",
	);
});
