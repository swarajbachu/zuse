import {
	mkdir,
	mkdtemp,
	readFile,
	realpath,
	rm,
	symlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import {
	ensureUnderCwd,
	handleFsRequest,
	isUnderCwd,
} from "@zuse/agents/drivers/acp/fs";
import type { PermissionKind } from "@zuse/contracts";
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

describe("handleFsRequest symlink containment", () => {
	/** Workspace with a committed-style `link` symlink pointing outside it. */
	const makeWorkspace = async () => {
		const root = await mkdtemp(path.join(tmpdir(), "zuse-acp-fs-link-"));
		const workspace = path.join(root, "workspace");
		const outside = path.join(root, "outside");
		await mkdir(workspace, { recursive: true });
		await mkdir(path.join(outside, "dir"), { recursive: true });
		await writeFile(path.join(outside, "secret.txt"), "classified");
		await writeFile(path.join(workspace, "notes.txt"), "hello");
		await symlink(outside, path.join(workspace, "link"));
		return { root, workspace, outside };
	};

	it("rejects reads that escape through a symlink", async () => {
		const { root, workspace } = await makeWorkspace();
		try {
			const ctx = { cwd: workspace };
			await expect(
				handleFsRequest(
					"fs/read_text_file",
					{ path: path.join(workspace, "link", "secret.txt") },
					ctx,
				),
			).rejects.toThrow(/escapes workspace/);
			await expect(
				handleFsRequest("fs/read_text_file", { path: "link/secret.txt" }, ctx),
			).rejects.toThrow(/escapes workspace/);
			await expect(
				handleFsRequest("fs/read_directory", { path: "link" }, ctx),
			).rejects.toThrow(/escapes workspace/);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("rejects writes that escape through a symlink", async () => {
		const { root, workspace, outside } = await makeWorkspace();
		try {
			const ctx = { cwd: workspace };
			await expect(
				handleFsRequest(
					"fs/write_text_file",
					{ path: "link/out.txt", content: "exfil" },
					ctx,
				),
			).rejects.toThrow(/escapes workspace/);
			await expect(
				readFile(path.join(outside, "out.txt"), "utf8"),
			).rejects.toThrow();
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("rejects writes through a dangling symlink whose target is outside", async () => {
		const { root, workspace, outside } = await makeWorkspace();
		try {
			// The link target does not exist yet — writeFile would follow the
			// link and create it outside the workspace if allowed through.
			await symlink(
				path.join(outside, "new-file.txt"),
				path.join(workspace, "dangling"),
			);
			await expect(
				handleFsRequest(
					"fs/write_text_file",
					{ path: "dangling", content: "exfil" },
					{ cwd: workspace },
				),
			).rejects.toThrow(/escapes workspace/);
			await expect(
				readFile(path.join(outside, "new-file.txt"), "utf8"),
			).rejects.toThrow();
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("rejects deletes on a symlink or a path through it", async () => {
		const { root, workspace, outside } = await makeWorkspace();
		try {
			const ctx = { cwd: workspace };
			await expect(
				handleFsRequest("fs/delete_file", { path: "link" }, ctx),
			).rejects.toThrow(/escapes workspace/);
			await expect(
				handleFsRequest("fs/delete_file", { path: "link/dir" }, ctx),
			).rejects.toThrow(/escapes workspace/);
			// The outside tree must be untouched.
			expect(await readFile(path.join(outside, "secret.txt"), "utf8")).toBe(
				"classified",
			);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("rejects move when the destination escapes through a symlink", async () => {
		const { root, workspace } = await makeWorkspace();
		try {
			const ctx = { cwd: workspace };
			await expect(
				handleFsRequest(
					"fs/move_file",
					{ source: "notes.txt", destination: "link/moved.txt" },
					ctx,
				),
			).rejects.toThrow(/escapes workspace/);
			// The source must not have been moved.
			expect(await readFile(path.join(workspace, "notes.txt"), "utf8")).toBe(
				"hello",
			);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("still allows legitimate nested paths", async () => {
		const { root, workspace } = await makeWorkspace();
		try {
			const ctx = {
				cwd: workspace,
				getRuntimeMode: () => "approval-required" as const,
				requestPermission: async () => ({ _tag: "AllowOnce" as const }),
			};
			await handleFsRequest("fs/create_directory", { path: "sub/dir" }, ctx);
			await handleFsRequest(
				"fs/write_text_file",
				{ path: "sub/dir/file.txt", content: "nested" },
				ctx,
			);
			const read = (await handleFsRequest(
				"fs/read_text_file",
				{ path: path.join(workspace, "sub", "dir", "file.txt") },
				ctx,
			)) as { content: string };
			expect(read.content).toBe("nested");
			await handleFsRequest(
				"fs/move_file",
				{ source: "sub/dir/file.txt", destination: "sub/dir/renamed.txt" },
				ctx,
			);
			await handleFsRequest("fs/delete_file", { path: "sub/dir" }, ctx);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("applies sensitive-path policy to the resolved target of a symlink", async () => {
		const { root, workspace } = await makeWorkspace();
		try {
			const envPath = path.join(workspace, ".env");
			await writeFile(envPath, "TOKEN=hunter2");
			// An in-workspace symlink whose target IS sensitive: the lexical
			// path looks harmless, so the check must run on the resolved path.
			await symlink(envPath, path.join(workspace, "alias"));

			const prompts: Array<{
				kind: PermissionKind;
				forcePrompt: boolean;
			}> = [];
			const ctx = {
				cwd: workspace,
				getRuntimeMode: () => "approval-required" as const,
				requestPermission: async (
					kind: PermissionKind,
					options: { readonly forcePrompt: boolean },
				) => {
					prompts.push({ kind, forcePrompt: options.forcePrompt });
					return { _tag: "AllowOnce" as const };
				},
			};

			const read = (await handleFsRequest(
				"fs/read_text_file",
				{ path: "alias" },
				ctx,
			)) as { content: string };
			expect(read.content).toBe("TOKEN=hunter2");
			expect(prompts).toHaveLength(1);
			expect(prompts[0]?.forcePrompt).toBe(true);
			expect(prompts[0]?.kind).toMatchObject({
				_tag: "FileWrite",
				path: await realpath(envPath),
			});
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("allows the scoped plan file reached through a resolved path", async () => {
		const root = await mkdtemp(path.join(tmpdir(), "zuse-acp-fs-plan-"));
		const workspace = path.join(root, "workspace");
		const sessionDirectory = path.join(root, "sessions");
		const planFilePath = path.join(sessionDirectory, "plan.md");
		try {
			await mkdir(workspace, { recursive: true });
			await mkdir(sessionDirectory, { recursive: true });
			await writeFile(planFilePath, "# draft");
			// A symlink inside the workspace pointing at the scoped plan file:
			// the lexical path is inside, the resolved path escapes — but it is
			// exactly the plan file, so plan mode must still allow it.
			await symlink(planFilePath, path.join(workspace, "plan-link"));
			let permissionRequests = 0;
			const ctx = {
				cwd: workspace,
				getRuntimeMode: () => "approval-required" as const,
				getPermissionMode: () => "plan" as const,
				requestPermission: async () => {
					permissionRequests += 1;
					return { _tag: "Deny" as const };
				},
			};

			await handleFsRequest(
				"fs/write_text_file",
				{ path: "plan-link", content: "# revised" },
				ctx,
				{ planFilePath },
			);
			expect(await readFile(planFilePath, "utf8")).toBe("# revised");
			expect(permissionRequests).toBe(0);

			// Outside plan mode the same path must be rejected as an escape.
			await expect(
				handleFsRequest(
					"fs/write_text_file",
					{ path: "plan-link", content: "nope" },
					{ ...ctx, getPermissionMode: () => "default" as const },
					{ planFilePath },
				),
			).rejects.toThrow(/escapes workspace/);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
});
