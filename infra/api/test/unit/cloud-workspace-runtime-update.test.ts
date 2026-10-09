import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import {
	mkdir,
	mkdtemp,
	readFile,
	rm,
	stat,
	writeFile,
} from "node:fs/promises";
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

// Explicit error propagation must survive callers using `if ! install_grok`.
test.each([
	{ name: "verified x86_64", arch: "x86_64", success: true },
	{ name: "verified aarch64", arch: "aarch64", success: true },
	{ name: "changed binary", arch: "x86_64", success: false, corrupt: true },
	{
		name: "failed download",
		arch: "x86_64",
		success: false,
		downloadFailure: true,
	},
	{
		name: "unusable binary",
		arch: "x86_64",
		success: false,
		startupFailure: true,
	},
	{ name: "unsupported platform", arch: "other", success: false },
])("Grok binary installation: $name", async (scenario) => {
	const root = await mkdtemp(join(tmpdir(), "zuse-grok-install-"));
	try {
		const target = join(root, "grok");
		const marker = join(root, "executed");
		const artifact = `#!/bin/sh\nprintf executed > "$GROK_TEST_MARKER"\nexit ${scenario.startupFailure ? 1 : 0}\n`;
		const fixture = join(root, "fixture");
		await writeFile(fixture, artifact);
		await writeFile(target, "existing executable");
		let source = readFileSync(
			new URL("../../../cloud-sandboxes/install-grok.sh", import.meta.url),
			"utf8",
		);
		if (!scenario.corrupt)
			source = source.replace(
				/digest=[a-f0-9]{64}/gu,
				`digest=${createHash("sha256").update(artifact).digest("hex")}`,
			);
		const generation =
			scenario.arch === "aarch64" ? "1787956595467474" : "1787956692848119";
		const result = spawnSync(
			"bash",
			[
				"-c",
				`${source}
uname() { if [ "$1" = -s ]; then printf Linux; else printf '%s' "$GROK_TEST_ARCH"; fi; }
curl() {
  local target url
  while [ "$#" -gt 0 ]; do
    case "$1" in
      -o) shift; target="$1" ;;
      https:*) url="$1" ;;
    esac
    shift
  done
  [ "$url" = "https://storage.googleapis.com/grok-build-public-artifacts/cli/grok-1.0.13-linux-${scenario.arch}?generation=${generation}" ] || return 91
  ${scenario.downloadFailure ? "return 1" : 'cp "$GROK_TEST_FIXTURE" "$target"'}
}
if ! install_grok; then exit 23; fi`,
			],
			{
				encoding: "utf8",
				timeout: 5000,
				env: {
					...process.env,
					GROK_BIN_DIR: root,
					GROK_TEST_MARKER: marker,
					GROK_TEST_FIXTURE: fixture,
					GROK_TEST_ARCH: scenario.arch,
				},
			},
		);
		expect(result.error).toBeUndefined();
		expect(result.status, result.stderr).toBe(scenario.success ? 0 : 23);
		expect(await readFile(target, "utf8")).toBe(
			scenario.success ? artifact : "existing executable",
		);
		if (scenario.success) expect((await stat(target)).mode & 0o777).toBe(0o755);
		expect(await readFile(marker, "utf8").catch(() => null)).toBe(
			scenario.success || scenario.startupFailure ? "executed" : null,
		);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
