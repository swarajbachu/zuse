import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { NodeServices } from "@effect/platform-node";
import { FolderId, GitFolderNotFoundError, WorktreeId } from "@zuse/contracts";
import { Effect, Layer } from "effect";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { GitService } from "./git-service.ts";
import { GitServiceLive } from "./git-service-live.ts";
import { RepositoryLocator } from "./repository-locator.ts";

const folderId = FolderId.make("repository-1");
const worktreeId = WorktreeId.make("worktree-1");

const git = (cwd: string, ...args: ReadonlyArray<string>): string =>
	execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

describe("GitServiceLive", () => {
	let temporaryRoot = "";
	let repositoryRoot = "";

	beforeEach(() => {
		temporaryRoot = mkdtempSync(join(tmpdir(), "zuse-git-service-"));
		repositoryRoot = join(temporaryRoot, "repository");
		mkdirSync(repositoryRoot);
		git(repositoryRoot, "init", "--initial-branch=main");
		git(repositoryRoot, "config", "user.name", "Test User");
		git(repositoryRoot, "config", "user.email", "test@example.com");
		writeFileSync(join(repositoryRoot, "README.md"), "first\n");
		git(repositoryRoot, "add", "README.md");
		git(repositoryRoot, "commit", "-m", "initial commit");
	});

	afterEach(() => {
		rmSync(temporaryRoot, { recursive: true, force: true });
	});

	const makeLayer = ({
		root = repositoryRoot,
		worktreePath = null,
	}: {
		readonly root?: string;
		readonly worktreePath?: string | null;
	} = {}) => {
		const LocatorLive = Layer.succeed(RepositoryLocator, {
			root: (requestedFolderId) =>
				requestedFolderId === folderId
					? Effect.succeed(root)
					: new GitFolderNotFoundError({ folderId: requestedFolderId }),
			worktreePath: (requestedWorktreeId) =>
				Effect.succeed(
					requestedWorktreeId === worktreeId ? worktreePath : null,
				),
			resolve: (requestedFolderId, requestedWorktreeId) =>
				requestedFolderId !== folderId
					? new GitFolderNotFoundError({ folderId: requestedFolderId })
					: Effect.succeed(
							requestedWorktreeId === worktreeId && worktreePath !== null
								? worktreePath
								: root,
						),
		});
		return GitServiceLive.pipe(
			Layer.provide(LocatorLive),
			Layer.provide(NodeServices.layer),
		);
	};

	const run = <A, E>(
		operation: (service: GitService["Service"]) => Effect.Effect<A, E>,
		layer = makeLayer(),
	) =>
		Effect.runPromise(
			Effect.flatMap(GitService, operation).pipe(Effect.provide(layer)),
		);

	test("reads log, status, branches, changes, and diffs from the repository", async () => {
		writeFileSync(join(repositoryRoot, "README.md"), "first\nsecond\n");
		writeFileSync(join(repositoryRoot, "new.txt"), "new\n");

		const [log, status, branches, changes, trackedDiff, untrackedDiff] =
			await run((service) =>
				Effect.all([
					service.log(folderId, 10),
					service.status(folderId),
					service.branches(folderId),
					service.changes(folderId),
					service.diff(folderId, "README.md"),
					service.diff(folderId, "new.txt"),
				]),
			);

		expect(log.map((entry) => entry.subject)).toEqual(["initial commit"]);
		expect(status).toMatchObject({ branch: "main", dirtyFiles: 2 });
		expect(branches).toEqual([
			expect.objectContaining({ name: "main", current: true, kind: "local" }),
		]);
		expect(changes.map((change) => change.path).sort()).toEqual([
			"README.md",
			"new.txt",
		]);
		expect(trackedDiff).toMatchObject({ mode: "worktree", truncated: false });
		expect(trackedDiff.patch).toContain("+second");
		expect(untrackedDiff).toMatchObject({
			mode: "untracked",
			truncated: false,
		});
		expect(untrackedDiff.patch).toContain("+++ b/new.txt");
	});

	test("commits changes and pushes the current branch", async () => {
		const remote = join(temporaryRoot, "remote.git");
		git(temporaryRoot, "init", "--bare", remote);
		git(repositoryRoot, "remote", "add", "origin", remote);
		writeFileSync(join(repositoryRoot, "README.md"), "committed\n");

		const commit = await run((service) =>
			service.commit(folderId, "update readme"),
		);
		await run((service) => service.push(folderId));

		expect(commit.sha).toBe(git(repositoryRoot, "rev-parse", "HEAD"));
		expect(git(remote, "rev-parse", "refs/heads/main")).toBe(commit.sha);
	});

	test("uses the selected worktree path", async () => {
		const worktreeRoot = join(temporaryRoot, "worktree");
		git(repositoryRoot, "worktree", "add", "-b", "feature", worktreeRoot);

		const status = await run(
			(service) => service.status(folderId, worktreeId),
			makeLayer({ worktreePath: worktreeRoot }),
		);

		expect(status.branch).toBe("feature");
	});

	test("maps a non-repository folder to GitNotARepoError", async () => {
		const notRepository = join(temporaryRoot, "not-repository");
		mkdirSync(notRepository);

		await expect(
			run(
				(service) => service.status(folderId),
				makeLayer({ root: notRepository }),
			),
		).rejects.toMatchObject({ _tag: "GitNotARepoError", folderId });
	});

	test("preserves missing folder failures from the locator", async () => {
		const missingFolderId = FolderId.make("missing");
		await expect(
			run((service) => service.status(missingFolderId)),
		).rejects.toMatchObject({
			_tag: "GitFolderNotFoundError",
			folderId: missingFolderId,
		});
	});
});
