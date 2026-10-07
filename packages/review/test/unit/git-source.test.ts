import { execFileSync } from "node:child_process";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { createGitReviewSource } from "../../src/index.ts";

it("reads pinned objects despite dirty checkout and excludes symlinks", async () => {
	const root = await mkdtemp(join(tmpdir(), "review-git-"));
	const git = (...args: string[]) =>
		execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();
	try {
		git("init", "-q");
		git("config", "user.email", "test@example.invalid");
		git("config", "user.name", "Test");
		await writeFile(join(root, "a.ts"), "export const a = 1;\n");
		git("add", ".");
		git("commit", "-qm", "base");
		const baseSha = git("rev-parse", "HEAD");
		await writeFile(join(root, "a.ts"), "export const a = 2;\n");
		await symlink("/etc/passwd", join(root, "escape"));
		git("add", ".");
		git("commit", "-qm", "head");
		const headSha = git("rev-parse", "HEAD");
		await writeFile(join(root, "a.ts"), "DIRTY CHECKOUT");
		const signal = new AbortController().signal;
		const source = await createGitReviewSource(
			root,
			{
				repositoryId: 1,
				baseRef: "main",
				baseSha,
				headSha,
				mergeBaseSha: baseSha,
			},
			signal,
		);
		expect(await source.readFile("RIGHT", "a.ts", signal)).toBe(
			"export const a = 2;\n",
		);
		expect(await source.readFile("LEFT", "a.ts", signal)).toBe(
			"export const a = 1;\n",
		);
		expect(await source.readFile("RIGHT", "escape", signal)).toBeNull();
		expect(
			source.changes.find((change) => change.path === "escape")?.excluded,
		).toBe(true);
		expect(
			source.changes.find((change) => change.path === "a.ts")?.addedLines,
		).toEqual([{ start: 1, end: 1 }]);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
