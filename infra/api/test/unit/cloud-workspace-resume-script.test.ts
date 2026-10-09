import { spawnSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
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

test("repository recovery failure is logged and marked before the runtime starts", () => {
	const root = mkdtempSync(join(tmpdir(), "zuse-resume-script-"));
	try {
		const state = join(root, "workspace");
		mkdirSync(state);
		const tools = join(root, "tools");
		mkdirSync(tools);
		writeFileSync(join(tools, "grok"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
		const repository = join(root, "not-a-repository");
		mkdirSync(repository);
		writeFileSync(join(root, "retained-data"), "keep");
		const script = WORKSPACE_RUNTIME_RESUME_SCRIPT.replaceAll(
			"/var/lib/zuse/workspace",
			state,
		);
		const result = spawnSync("bash", ["-c", script], {
			env: {
				...process.env,
				PATH: `${tools}:${process.env.PATH}`,
				ZUSE_RUNTIME_MANIFEST_URL: "",
				ZUSE_CLOUD_WORKSPACE_ID: "child",
				ZUSE_RUNTIME_GENERATION: "2",
				ZUSE_CLOUD_WORKSPACE_ROOT: repository,
				ZUSE_BRANCH: "fork",
				ZUSE_BASE_REF: "missing-parent",
				ZUSE_REPOSITORY_URL: "https://example.com/repo.git",
			},
			encoding: "utf8",
		});
		expect(result.status).toBe(1);
		expect(existsSync(join(state, "failed"))).toBe(true);
		expect(existsSync(join(state, "repository-ready"))).toBe(false);
		expect(readFileSync(join(state, "failure-phase"), "utf8").trim()).toBe(
			"syncing-repository",
		);
		expect(readFileSync(join(state, "runtime.log"), "utf8")).toContain(
			"not a git repository",
		);
		expect(readFileSync(join(state, "runtime.log"), "utf8")).not.toContain(
			"runtime.exec",
		);
		expect(readFileSync(join(root, "retained-data"), "utf8")).toBe("keep");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
