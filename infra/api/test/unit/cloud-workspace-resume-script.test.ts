import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import { WORKSPACE_RUNTIME_RESUME_SCRIPT } from "../../src/cloud-workspace-reconciler.ts";

vi.mock("../../../cloud-sandboxes/workspace-repository.sh", async () => {
	const { readFile } = await import("node:fs/promises");
	return {
		default: await readFile(
			new URL(
				"../../../cloud-sandboxes/workspace-repository.sh",
				import.meta.url,
			),
			"utf8",
		),
	};
});

vi.mock("../../../cloud-sandboxes/install-grok.sh", () => ({
	default: readFileSync(
		new URL("../../../cloud-sandboxes/install-grok.sh", import.meta.url),
		"utf8",
	),
}));

vi.mock("../../../cloud-sandboxes/workspace-runtime.sh", () => ({
	default: readFileSync(
		new URL("../../../cloud-sandboxes/workspace-runtime.sh", import.meta.url),
		"utf8",
	),
}));

test("repository recovery failure is reported while the early runtime is connected", () => {
	const root = mkdtempSync(join(tmpdir(), "zuse-resume-script-"));
	try {
		const state = join(root, "workspace");
		mkdirSync(state);
		const tools = join(root, "tools");
		mkdirSync(tools);
		writeFileSync(join(tools, "grok"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
		const release = join(root, "release");
		mkdirSync(release);
		writeFileSync(
			join(release, "bin.mjs"),
			`import { existsSync } from "node:fs";
		const timer = setInterval(() => { if (existsSync(process.env.ZUSE_WORKSPACE_RUNTIME_STATUS_DIR + "/failed")) { clearInterval(timer); process.exit(128); } }, 10);`,
		);
		const repository = join(root, "not-a-repository");
		mkdirSync(repository);
		writeFileSync(join(root, "retained-data"), "keep");
		const script = WORKSPACE_RUNTIME_RESUME_SCRIPT.replaceAll(
			"/var/lib/zuse/workspace",
			state,
		).replaceAll("/opt/zuse/current", release);
		const result = spawnSync("bash", ["-c", script], {
			env: {
				...process.env,
				PATH: `${tools}:${process.env.PATH}`,
				ZUSE_RUNTIME_MANIFEST_URL: "",
				ZUSE_RUNTIME_NODE: process.execPath,
				ZUSE_WORKSPACE_RUNTIME_STATUS_DIR: state,
				ZUSE_CLOUD_WORKSPACE_ID: "child",
				ZUSE_USER_DATA: join(root, "data"),
				ZUSE_RUNTIME_GENERATION: "2",
				ZUSE_CLOUD_WORKSPACE_ROOT: repository,
				ZUSE_BRANCH: "fork",
				ZUSE_BASE_REF: "missing-parent",
				ZUSE_REPOSITORY_URL: "https://example.com/repo.git",
			},
			encoding: "utf8",
			timeout: 5000,
		});
		expect(result.status).toBe(128);
		expect(existsSync(join(state, "failed"))).toBe(true);
		expect(existsSync(join(state, "repository-ready"))).toBe(false);
		expect(readFileSync(join(state, "failure-phase"), "utf8").trim()).toBe(
			"syncing-repository",
		);
		expect(readFileSync(join(state, "runtime.log"), "utf8")).toContain(
			"not a git repository",
		);
		expect(readFileSync(join(state, "runtime.log"), "utf8")).toContain(
			"runtime.exec",
		);
		expect(readFileSync(join(root, "retained-data"), "utf8")).toBe("keep");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

const runtimeLauncher = readFileSync(
	new URL("../../../cloud-sandboxes/workspace-runtime.sh", import.meta.url),
	"utf8",
);
const runtimeFixture = () => {
	const root = mkdtempSync(join(tmpdir(), "zuse-runtime-launch-"));
	const state = join(root, "workspace");
	const release = join(root, "release");
	mkdirSync(state);
	mkdirSync(release);
	writeFileSync(join(state, "repository-ready"), "");
	writeFileSync(join(root, "retained-data"), "original sqlite and WAL state");
	const entries = join(root, "entries");
	const installs = join(root, "installs");
	const installer = join(root, "installer.mjs");
	writeFileSync(
		installer,
		`import { appendFileSync } from "node:fs";
		appendFileSync(process.env.ZUSE_TEST_INSTALLS, process.env.ZUSE_RUNTIME_GENERATION + "\\n");
		process.exit(Number(process.env.ZUSE_TEST_INSTALL_EXIT ?? "0"));`,
	);
	writeFileSync(
		join(release, "bin.mjs"),
		`import { appendFileSync } from "node:fs";
		appendFileSync(process.env.ZUSE_TEST_ENTRIES, process.env.ZUSE_RUNTIME_GENERATION + "\\n");
		setInterval(() => {}, 1000);`,
	);
	const script = WORKSPACE_RUNTIME_RESUME_SCRIPT.replaceAll(
		"/var/lib/zuse/workspace",
		state,
	).replaceAll("/opt/zuse/current", release);
	const env = {
		...process.env,
		ZUSE_RUNTIME_NODE: process.execPath,
		ZUSE_RUNTIME_ACTIVATION_MODE: "activate",
		ZUSE_RUNTIME_ACTIVATION_INSTALLER: installer,
		ZUSE_CLOUD_WORKSPACE_ID: "workspace",
		ZUSE_RUNTIME_GENERATION: "8",
		ZUSE_RUNTIME_BOOT_TOKEN: "one-shot-test-token",
		ZUSE_TEST_ENTRIES: entries,
		ZUSE_USER_DATA: join(root, "data"),
		ZUSE_TEST_INSTALLS: installs,
		ZUSE_WORKSPACE_RUNTIME_STATUS_DIR: state,
	};
	return { root, state, release, script, env, entries, installs };
};

test("a second process cannot activate or enter enrollment while the runtime owns its lifetime lock", async () => {
	const f = runtimeFixture();
	const first = spawn("bash", ["-c", f.script], {
		env: f.env,
		stdio: "ignore",
	});
	const exited = once(first, "exit");
	try {
		await vi.waitFor(() => expect(existsSync(f.entries)).toBe(true));
		const second = spawnSync("bash", ["-c", f.script], {
			env: {
				...f.env,
				ZUSE_RUNTIME_GENERATION: "9",
				ZUSE_RUNTIME_BOOT_TOKEN: "another-one-shot-token",
			},
			encoding: "utf8",
		});
		expect(second.status, second.stderr).toBe(75);
		expect(readFileSync(f.installs, "utf8")).toBe("8\n");
		expect(readFileSync(f.entries, "utf8")).toBe("8\n");
		expect(existsSync(join(f.state, "failed"))).toBe(false);
		const failures = readdirSync(join(f.state, "attempts"))
			.map((entry) => join(f.state, "attempts", entry))
			.filter((directory) => existsSync(join(directory, "failure-phase")));
		expect(failures).toHaveLength(1);
		expect(
			readFileSync(join(failures[0] ?? "", "failure-phase"), "utf8").trim(),
		).toBe("acquiring-runtime-lock");
		expect(
			readFileSync(join(failures[0] ?? "", "generation"), "utf8").trim(),
		).toBe("9");
		expect(
			readFileSync(join(failures[0] ?? "", "exit-code"), "utf8").trim(),
		).toBe("75");
	} finally {
		first.kill("SIGTERM");
		await exited;
		rmSync(f.root, { recursive: true, force: true });
	}
});

test("an inherited bootstrap lock survives exec and is released when its owner exits", async () => {
	const f = runtimeFixture();
	const childScript = `${runtimeLauncher}
		initialize_workspace_runtime_attempt
		exec_workspace_runtime "$ZUSE_RUNTIME_NODE" "$1"`;
	const wrapper = `${runtimeLauncher}
		initialize_workspace_runtime_attempt
		acquire_workspace_runtime_lock
		exec bash -c "$1" bootstrap "$2"`;
	const first = spawn(
		"bash",
		["-c", wrapper, "wrapper", childScript, join(f.release, "bin.mjs")],
		{ env: f.env, stdio: "ignore" },
	);
	const exited = once(first, "exit");
	try {
		await vi.waitFor(() => expect(existsSync(f.entries)).toBe(true));
		expect(
			spawnSync("flock", [
				"--nonblock",
				join(f.env.ZUSE_USER_DATA, ".workspace-runtime.lock"),
				"true",
			]).status,
		).not.toBe(0);
		first.kill("SIGTERM");
		await exited;
		expect(
			spawnSync("flock", [
				"--nonblock",
				join(f.env.ZUSE_USER_DATA, ".workspace-runtime.lock"),
				"true",
			]).status,
		).toBe(0);
	} finally {
		if (first.exitCode === null && first.signalCode === null) {
			first.kill("SIGTERM");
			await exited;
		}
		rmSync(f.root, { recursive: true, force: true });
	}
});

test("installer failure records the attempt phase before enrollment and preserves retained data", () => {
	const f = runtimeFixture();
	try {
		const result = spawnSync("bash", ["-c", f.script], {
			env: { ...f.env, ZUSE_TEST_INSTALL_EXIT: "23" },
			encoding: "utf8",
		});
		expect(result.status, result.stderr).toBe(23);
		expect(existsSync(f.entries)).toBe(false);
		expect(readFileSync(join(f.state, "failure-phase"), "utf8").trim()).toBe(
			"updating-runtime",
		);
		expect(existsSync(join(f.state, "failed"))).toBe(true);
		expect(readFileSync(join(f.root, "retained-data"), "utf8")).toBe(
			"original sqlite and WAL state",
		);
		const attempt = readdirSync(join(f.state, "attempts"))[0];
		const failure = readFileSync(
			join(f.state, "attempts", attempt ?? "", "failure-phase"),
			"utf8",
		);
		expect(failure).not.toContain("one-shot-test-token");
		expect(failure.trim()).toBe("updating-runtime");
	} finally {
		rmSync(f.root, { recursive: true, force: true });
	}
});
