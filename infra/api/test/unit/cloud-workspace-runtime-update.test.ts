import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import { WORKSPACE_RUNTIME_UPDATE_SCRIPT } from "../../src/cloud-workspace-runtime-update.ts";

vi.mock("../../../cloud-sandboxes/install-grok.sh", () => ({
	default: readFileSync(
		new URL("../../../cloud-sandboxes/install-grok.sh", import.meta.url),
		"utf8",
	),
}));

test.each([
	{ name: "old image", version: 5, updates: 1, success: true },
	{ name: "compatible image", version: 6, updates: 0, success: true },
	{ name: "missing metadata", version: null, updates: 1, success: true },
	{ name: "invalid metadata", version: "broken", updates: 1, success: true },
	{
		name: "updater failure",
		version: 5,
		updates: 1,
		success: false,
		fail: true,
	},
	{
		name: "incompatible installed artifact",
		version: 5,
		updates: 1,
		success: false,
		installedVersion: 5,
	},
	{
		name: "missing signing key",
		version: 5,
		updates: 0,
		success: false,
		missingKey: true,
	},
	{
		name: "explicit restart applies fixes",
		version: 6,
		updates: 1,
		success: true,
		force: true,
	},
])("runtime startup: $name", async (scenario) => {
	const root = await mkdtemp(join(tmpdir(), "zuse-runtime-start-"));
	try {
		const status = join(root, "workspace");
		const current = join(root, "current");
		const updater = join(root, "updater.mjs");
		const key = join(root, "public.jwk");
		await mkdir(current);
		await mkdir(status);
		const tools = join(root, "tools");
		await mkdir(tools);
		await writeFile(join(tools, "grok"), "#!/bin/sh\nexit 0\n", {
			mode: 0o755,
		});
		// The compatibility gate must not initialize, move, or replace runtime data.
		const database = join(status, "zuse.sqlite");
		await writeFile(database, "existing chat and queued command");
		if (!scenario.missingKey) await writeFile(key, "test key");
		if (scenario.version !== null) {
			await writeFile(
				join(current, "runtime-metadata.json"),
				scenario.version === "broken"
					? "invalid JSON"
					: JSON.stringify({
							schemaVersion: 1,
							wireProtocolVersion: scenario.version,
						}),
			);
		}
		await writeFile(
			updater,
			`
import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(join(root, "updated"))}, "updated");
if (process.env.ZUSE_RUNTIME_INSTALL_ONLY !== "1" || process.env.ZUSE_RUNTIME_SKIP_TOOLCHAIN !== "1") process.exit(2);
if (${JSON.stringify(scenario.fail ?? false)}) process.exit(1);
writeFileSync(${JSON.stringify(join(current, "runtime-metadata.json"))}, JSON.stringify({ schemaVersion: 1, wireProtocolVersion: ${scenario.installedVersion ?? 6} }));
`,
		);
		const script = WORKSPACE_RUNTIME_UPDATE_SCRIPT.replaceAll(
			"/var/lib/zuse/workspace",
			status,
		).replaceAll("/usr/local/lib/zuse/runtime-updater.mjs", updater);
		const result = spawnSync(
			"bash",
			[
				"-c",
				`set -e\n${script}\nensure_workspace_runtime ${scenario.force ? "1" : "0"}\nprintf launched`,
			],
			{
				encoding: "utf8",
				timeout: 5_000,
				env: {
					...process.env,
					PATH: `${tools}:${process.env.PATH}`,
					ZUSE_CURRENT_LINK: current,
					ZUSE_RUNTIME_MANIFEST_URL: "https://runtime.invalid/manifest.json",
					ZUSE_RUNTIME_PUBLIC_KEY_FILE: key,
					ZUSE_RUNTIME_WIRE_PROTOCOL: "6",
				},
			},
		);
		expect(result.error).toBeUndefined();
		expect(result.status, result.stderr).toBe(scenario.success ? 0 : 1);
		expect(result.stdout).toBe(scenario.success ? "launched" : "");
		expect(await readFile(join(root, "updated"), "utf8").catch(() => "")).toBe(
			scenario.updates ? "updated" : "",
		);
		if (!scenario.success) {
			expect(await readFile(join(status, "failure-phase"), "utf8")).toBe(
				"updating-runtime\n",
			);
		}
		expect(await readFile(database, "utf8")).toBe(
			"existing chat and queued command",
		);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

// Older snapshots can have a compatible runtime and still lack its provider CLI.
test.each([
	true,
	false,
])("missing Grok installation success=%s preserves runtime data", async (success) => {
	const root = await mkdtemp(join(tmpdir(), "zuse-grok-start-"));
	try {
		const status = join(root, "workspace");
		await mkdir(status);
		const database = join(status, "zuse.sqlite");
		await writeFile(database, "existing chat and queued command");
		const marker = join(root, "installed");
		const script = WORKSPACE_RUNTIME_UPDATE_SCRIPT.replaceAll(
			"/var/lib/zuse/workspace",
			status,
		);
		const result = spawnSync(
			"bash",
			[
				"-c",
				`set -e
${script}
command() { if [ "$1" = "-v" ] && [ "$2" = grok ]; then return 1; fi; builtin command "$@"; }
install_grok() { printf installed > '${marker}'; return ${success ? 0 : 1}; }
ensure_workspace_runtime 0
printf launched`,
			],
			{
				encoding: "utf8",
				timeout: 5000,
				env: { ...process.env, ZUSE_RUNTIME_MANIFEST_URL: "" },
			},
		);
		expect(result.status, result.stderr).toBe(success ? 0 : 1);
		expect(result.stdout).toBe(success ? "launched" : "");
		expect(await readFile(marker, "utf8")).toBe("installed");
		if (!success)
			expect(await readFile(join(status, "failure-phase"), "utf8")).toBe(
				"installing-agent-cli\n",
			);
		expect(await readFile(database, "utf8")).toBe(
			"existing chat and queued command",
		);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

// A failed pinned checksum must abort even when the caller uses `if ! install_grok`.
test("Grok installer rejects changed downloads before executing them", async () => {
	const root = await mkdtemp(join(tmpdir(), "zuse-grok-checksum-"));
	try {
		const source = readFileSync(
			new URL("../../../cloud-sandboxes/install-grok.sh", import.meta.url),
			"utf8",
		);
		const result = spawnSync(
			"bash",
			[
				"-c",
				`${source}
  curl() { local target; while [ "$#" -gt 0 ]; do if [ "$1" = -o ]; then shift; target="$1"; fi; shift; done; printf 'touch "$HOME/executed"' > "$target"; }
  if ! install_grok; then exit 23; fi`,
			],
			{ encoding: "utf8", timeout: 5000, env: { ...process.env, HOME: root } },
		);
		expect(result.status).toBe(23);
		expect(
			await readFile(join(root, "executed"), "utf8").catch(() => null),
		).toBeNull();
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
