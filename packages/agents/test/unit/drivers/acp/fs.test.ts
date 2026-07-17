import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import {
	ensureUnderCwd,
	handleFsRequest,
	isUnderCwd,
} from "@zuse/agents/drivers/acp/fs";
import { describe, expect, it } from "vitest";

const cwd = "/work/repo";

describe("isUnderCwd", () => {
	it("accepts the cwd itself and nested paths", () => {
		expect(isUnderCwd("/work/repo", cwd)).toBe(true);
		expect(isUnderCwd("/work/repo/src/a.ts", cwd)).toBe(true);
		expect(isUnderCwd("/work/repo/deep/nested/file", cwd)).toBe(true);
	});

	it("rejects parent traversal that escapes the cwd", () => {
		expect(isUnderCwd("/work/repo/../secret", cwd)).toBe(false);
		expect(isUnderCwd("/work/repo/../../etc/passwd", cwd)).toBe(false);
	});

	it("rejects sibling directories with a shared prefix", () => {
		// `/work/repo-evil` shares the `/work/repo` string prefix but is NOT under cwd.
		expect(isUnderCwd("/work/repo-evil/file", cwd)).toBe(false);
	});

	it("rejects unrelated absolute paths", () => {
		expect(isUnderCwd("/etc/passwd", cwd)).toBe(false);
	});

	it("resolves relative paths against process cwd before comparing", () => {
		// A traversal that normalizes back under cwd is accepted.
		expect(isUnderCwd("/work/repo/src/../src/a.ts", cwd)).toBe(true);
	});
});

describe("ensureUnderCwd", () => {
	it("returns the resolved absolute path for in-workspace targets", () => {
		expect(ensureUnderCwd("/work/repo/src/a.ts", cwd)).toBe(
			path.resolve("/work/repo/src/a.ts"),
		);
	});

	it("throws when the path escapes the workspace", () => {
		expect(() => ensureUnderCwd("/work/repo/../secret", cwd)).toThrow(
			/escapes workspace/,
		);
		expect(() => ensureUnderCwd("/etc/passwd", cwd)).toThrow(
			/escapes workspace/,
		);
	});
});

describe("handleFsRequest plan file scope", () => {
	it("allows only the explicitly scoped plan file during plan mode", async () => {
		const root = await mkdtemp(path.join(tmpdir(), "zuse-acp-fs-"));
		const workspace = path.join(root, "workspace");
		const sessionDirectory = path.join(root, "sessions", "active-session");
		const planFilePath = path.join(sessionDirectory, "plan.md");
		await mkdir(workspace, { recursive: true });
		await mkdir(sessionDirectory, { recursive: true });
		let permissionRequests = 0;
		const context = {
			cwd: workspace,
			getRuntimeMode: () => "approval-required" as const,
			getPermissionMode: () => "plan" as const,
			requestPermission: async () => {
				permissionRequests += 1;
				return { _tag: "Deny" as const };
			},
		};

		try {
			await handleFsRequest(
				"fs/write_text_file",
				{ path: planFilePath, content: "# Proposed plan" },
				context,
				{ planFilePath },
			);

			expect(await readFile(planFilePath, "utf8")).toBe("# Proposed plan");
			await expect(
				handleFsRequest(
					"fs/read_text_file",
					{ path: planFilePath },
					{ ...context, getPermissionMode: () => "default" as const },
					{ planFilePath },
				),
			).rejects.toThrow(/escapes workspace/);
			expect(permissionRequests).toBe(0);
			await expect(
				handleFsRequest(
					"fs/write_text_file",
					{
						path: path.join(sessionDirectory, "credentials.json"),
						content: "blocked",
					},
					context,
					{ planFilePath },
				),
			).rejects.toThrow(/escapes workspace/);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
});
