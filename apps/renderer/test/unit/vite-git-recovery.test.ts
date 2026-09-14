import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { watchGitRevision } from "../../vite-git-recovery.ts";

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
	for (const close of cleanup.reverse()) await close();
	cleanup.length = 0;
});
async function repository() {
	const root = await mkdtemp(join(tmpdir(), "zuse-git-recovery-"));
	cleanup.push(() => rm(root, { recursive: true, force: true }));
	execFileSync("git", ["init", "-q", "--initial-branch=main"], { cwd: root });
	const ref = join(root, ".git/refs/heads/main");
	await writeFile(ref, `${"a".repeat(40)}\n`);
	return { root, ref };
}
it("rebuilds once after a settled revision change, not during a merge", async () => {
	const { root, ref } = await repository();
	const restart = vi.fn(async () => {});
	cleanup.push(await watchGitRevision(root, restart, 20));
	await writeFile(join(root, ".git/MERGE_HEAD"), "merging");
	await writeFile(ref, `${"b".repeat(40)}\n`);
	await new Promise((resolve) => setTimeout(resolve, 100));
	expect(restart).not.toHaveBeenCalled();
	await rm(join(root, ".git/MERGE_HEAD"));
	await vi.waitFor(() => expect(restart).toHaveBeenCalledOnce());
	await new Promise((resolve) => setTimeout(resolve, 100));
	expect(restart).toHaveBeenCalledOnce();
});
it("supports linked worktrees, detached HEAD, rebase locks, and cleanup", async () => {
	const { root } = await repository();
	const worktree = join(root, "linked");
	const gitDir = join(root, ".git/worktrees/linked");
	await mkdir(worktree);
	await mkdir(gitDir, { recursive: true });
	await writeFile(join(worktree, ".git"), `gitdir: ${gitDir}\n`);
	await writeFile(join(gitDir, "commondir"), "../..\n");
	await writeFile(join(gitDir, "gitdir"), `${worktree}/.git\n`);
	await writeFile(join(gitDir, "HEAD"), `${"a".repeat(40)}\n`);
	const restart = vi.fn(async () => {});
	const stop = await watchGitRevision(worktree, restart, 20);
	cleanup.push(stop);
	await mkdir(join(gitDir, "rebase-merge"));
	await writeFile(join(gitDir, "HEAD"), `${"c".repeat(40)}\n`);
	await new Promise((resolve) => setTimeout(resolve, 100));
	expect(restart).not.toHaveBeenCalled();
	await rm(join(gitDir, "rebase-merge"), { recursive: true });
	await vi.waitFor(() => expect(restart).toHaveBeenCalledOnce());
	stop();
	await writeFile(join(gitDir, "HEAD"), `${"d".repeat(40)}\n`);
	await new Promise((resolve) => setTimeout(resolve, 100));
	expect(restart).toHaveBeenCalledOnce();
});
