import { execFileSync } from "node:child_process";
import {
	chmodSync,
	closeSync,
	ftruncateSync,
	mkdirSync,
	mkdtempSync,
	openSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { NodeFileSystem, NodePath, NodeServices } from "@effect/platform-node";
import { FolderId, GitFolderNotFoundError, WorktreeId } from "@zuse/contracts";
import {
	Effect,
	Fiber,
	FileSystem,
	Layer,
	type Path,
	PlatformError,
	Stream,
} from "effect";
import { ChildProcessSpawner } from "effect/unstable/process";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { GitService } from "../../src/git-service.ts";
import { GitServiceLive } from "../../src/git-service-live.ts";
import { RepositoryLocator } from "../../src/repository-locator.ts";
import { makeWorkspaceChangeStreams } from "../../src/workspace-change-streams.ts";

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
		platform = NodeServices.layer,
	}: {
		readonly root?: string;
		readonly worktreePath?: string | null;
		readonly platform?: Layer.Layer<
			| FileSystem.FileSystem
			| Path.Path
			| ChildProcessSpawner.ChildProcessSpawner
		>;
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
			Layer.provide(platform),
		);
	};

	const run = <A, E>(
		operation: (service: GitService["Service"]) => Effect.Effect<A, E>,
		layer = makeLayer(),
	) =>
		Effect.runPromise(
			Effect.flatMap(GitService, operation).pipe(Effect.provide(layer)),
		);

	test("does not carry edits made during fetch onto a new origin branch", async () => {
		const remote = join(temporaryRoot, "fetch-origin.git");
		git(temporaryRoot, "init", "--bare", remote);
		git(repositoryRoot, "remote", "add", "origin", remote);
		git(repositoryRoot, "push", "origin", "main");
		git(repositoryRoot, "switch", "-c", "old-feature");
		git(repositoryRoot, "update-ref", "-d", "refs/remotes/origin/main");
		const hook = join(repositoryRoot, ".git", "hooks", "reference-transaction");
		writeFileSync(
			hook,
			'#!/bin/sh\nif [ "$1" = "committed" ]; then printf "editor change\\n" > arrived-during-fetch.txt; fi\n',
		);
		chmodSync(hook, 0o755);
		await expect(
			run((service) =>
				Effect.flip(
					service.switchBranch(
						folderId,
						"new-feature",
						null,
						null,
						"origin/main",
					),
				),
			),
		).resolves.toMatchObject({
			reason: "Commit or stash changes before starting from origin/main.",
		});
		expect(git(repositoryRoot, "branch", "--show-current")).toBe("old-feature");
		expect(
			readFileSync(join(repositoryRoot, "arrived-during-fetch.txt"), "utf8"),
		).toContain("editor change");
	});

	test("creates a branch from fetched origin/main without moving local changes", async () => {
		const remote = join(temporaryRoot, "branch-origin.git");
		git(temporaryRoot, "init", "--bare", remote);
		git(repositoryRoot, "remote", "add", "origin", remote);
		git(repositoryRoot, "push", "-u", "origin", "main");
		git(repositoryRoot, "switch", "-c", "old-feature");
		writeFileSync(join(repositoryRoot, "README.md"), "uncommitted");
		await expect(
			run((service) =>
				service.switchBranch(
					folderId,
					"next-feature",
					null,
					null,
					"origin/main",
				),
			),
		).rejects.toMatchObject({
			reason: "Commit or stash changes before starting from origin/main.",
		});
		expect(git(repositoryRoot, "branch", "--show-current")).toBe("old-feature");
		git(repositoryRoot, "add", ".");
		git(repositoryRoot, "commit", "-m", "old feature");
		const status = await run((service) =>
			service.switchBranch(folderId, "next-feature", null, null, "origin/main"),
		);
		expect(status.branch).toBe("next-feature");
		expect(git(repositoryRoot, "rev-parse", "HEAD")).toBe(
			git(remote, "rev-parse", "main"),
		);
		await expect(
			run((service) =>
				service.switchBranch(folderId, "next-feature", null, null, "HEAD"),
			),
		).rejects.toThrow();
	});

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

	test("returns one coherent local workspace projection", async () => {
		writeFileSync(join(repositoryRoot, "README.md"), "first\nsecond\n");
		writeFileSync(join(repositoryRoot, "new.txt"), "new\n");

		const snapshot = await run((service) =>
			service.workspaceSnapshot(folderId),
		);

		expect(snapshot.status).toMatchObject({
			branch: "main",
			dirtyFiles: 2,
		});
		expect(snapshot.changes.map((change) => change.path).sort()).toEqual([
			"README.md",
			"new.txt",
		]);
		expect(snapshot.reviewSummary).toMatchObject({
			headRef: "main",
			additions: 3,
			deletions: 0,
		});
		expect(
			snapshot.reviewSummary.files.map((file) => file.path).sort(),
		).toEqual(["README.md", "new.txt"]);

		writeFileSync(join(repositoryRoot, "README.md"), "first\nthird!\n");
		const sameShape = await run((service) =>
			service.workspaceSnapshot(folderId),
		);
		expect(sameShape.status.dirtyFiles).toBe(snapshot.status.dirtyFiles);
		expect(sameShape.reviewSummary.additions).toBe(
			snapshot.reviewSummary.additions,
		);
		expect(sameShape.localFingerprint).not.toBe(snapshot.localFingerprint);
	});

	test("bounds a real workspace snapshot and patch stream for a 512 MiB untracked file", async () => {
		const largePath = join(repositoryRoot, "large.bin");
		const fd = openSync(largePath, "w");
		ftruncateSync(fd, 512 * 1024 * 1024);
		closeSync(fd);
		let largeContentReads = 0;
		const GuardedFileSystemLive = Layer.effect(
			FileSystem.FileSystem,
			Effect.map(FileSystem.FileSystem, (service) => ({
				...service,
				readFileString: (target: string, encoding?: string) => {
					if (target === largePath) {
						largeContentReads += 1;
						return Effect.die(
							new Error("oversized file content must not be read"),
						);
					}
					return service.readFileString(target, encoding);
				},
			})),
		);
		const platform = Layer.provideMerge(
			GuardedFileSystemLive,
			NodeServices.layer,
		);
		const startedAt = performance.now();

		const [snapshot, patches, directDiff] = await run(
			(service) =>
				Effect.all([
					service.workspaceSnapshot(folderId),
					Stream.runCollect(service.reviewPatches(folderId)),
					service.diff(folderId, "large.bin"),
				]),
			makeLayer({ platform }),
		);

		expect(performance.now() - startedAt).toBeLessThan(2_000);
		expect(largeContentReads).toBe(0);
		expect(
			snapshot.reviewSummary.files.find((file) => file.path === "large.bin"),
		).toMatchObject({ additions: 0, deletions: 0, binary: true });
		expect(
			Array.from(patches).find((patch) => patch.path === "large.bin"),
		).toMatchObject({
			result: { mode: "binary", patch: "", bytes: 0, truncated: false },
			error: null,
		});
		expect(directDiff).toMatchObject({
			mode: "binary",
			patch: "",
			bytes: 512 * 1024 * 1024,
			truncated: true,
		});
	}, 5_000);

	test("distinguishes Git repositories from plain directories", async () => {
		const plainDirectory = join(temporaryRoot, "plain-directory");
		mkdirSync(plainDirectory);

		await expect(
			run((service) => service.isRepository(folderId)),
		).resolves.toBe(true);
		await expect(
			run(
				(service) => service.isRepository(folderId),
				makeLayer({ root: plainDirectory }),
			),
		).resolves.toBe(false);
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

	test("reviews committed, pushed, and uncommitted branch changes from the merge base", async () => {
		const remote = join(temporaryRoot, "remote.git");
		git(temporaryRoot, "init", "--bare", remote);
		git(repositoryRoot, "remote", "add", "origin", remote);
		git(repositoryRoot, "push", "-u", "origin", "main");
		git(repositoryRoot, "remote", "set-head", "origin", "main");
		git(repositoryRoot, "switch", "-c", "feature");
		writeFileSync(join(repositoryRoot, "README.md"), "first\ncommitted\n");
		writeFileSync(join(repositoryRoot, "branch.txt"), "branch\n");
		git(repositoryRoot, "add", ".");
		git(repositoryRoot, "commit", "-m", "branch work");
		git(repositoryRoot, "push", "-u", "origin", "feature");
		writeFileSync(
			join(repositoryRoot, "README.md"),
			"first\ncommitted\nuncommitted\n",
		);
		writeFileSync(join(repositoryRoot, "untracked.txt"), "new\n");

		const [summary, readmeDiff, streamed] = await run((service) =>
			Effect.all([
				service.reviewSummary(folderId),
				service.diff(folderId, "README.md"),
				Stream.runCollect(service.reviewPatches(folderId)),
			]),
		);

		expect(summary.baseRef).toBe("origin/main");
		expect(summary.files.map((file) => file.path)).toEqual([
			"branch.txt",
			"README.md",
			"untracked.txt",
		]);
		expect(
			summary.files.find((file) => file.path === "README.md"),
		).toMatchObject({ kind: "modified", hasUncommittedChanges: true });
		expect(readmeDiff.patch).toContain("+committed");
		expect(readmeDiff.patch).toContain("+uncommitted");
		expect(Array.from(streamed, (entry) => entry.path)).toEqual(
			summary.files.map((file) => file.path),
		);
		const streamedText = Array.from(
			streamed,
			(entry) => entry.result.patch,
		).join("\n");
		expect(streamedText).toContain("+committed");
		expect(streamedText).toContain("+uncommitted");
	});

	test("separates staged and unstaged review ranges", async () => {
		writeFileSync(join(repositoryRoot, "staged.txt"), "staged\n");
		git(repositoryRoot, "add", "staged.txt");
		writeFileSync(join(repositoryRoot, "README.md"), "first\nunstaged\n");
		writeFileSync(join(repositoryRoot, "untracked.txt"), "untracked\n");

		const [staged, unstaged, stagedPatches, unstagedPatches] = await run(
			(service) =>
				Effect.all([
					service.reviewSummary(folderId, null, "staged"),
					service.reviewSummary(folderId, null, "unstaged"),
					Stream.runCollect(service.reviewPatches(folderId, null, "staged")),
					Stream.runCollect(service.reviewPatches(folderId, null, "unstaged")),
				]),
		);

		expect(staged.files.map((file) => file.path)).toEqual(["staged.txt"]);
		expect(staged.scope).toBe("staged");
		expect(unstaged.files.map((file) => file.path)).toEqual([
			"README.md",
			"untracked.txt",
		]);
		expect(unstaged.scope).toBe("unstaged");
		expect(
			Array.from(stagedPatches, (patch) => patch.result.patch).join("\n"),
		).toContain("+staged");
		expect(
			Array.from(unstagedPatches, (patch) => patch.result.patch).join("\n"),
		).toContain("+unstaged");
	});

	test("restores a reviewed file to the comparison base as a worktree change", async () => {
		git(repositoryRoot, "switch", "-c", "feature");
		writeFileSync(join(repositoryRoot, "README.md"), "changed\n");
		git(repositoryRoot, "add", "README.md");
		git(repositoryRoot, "commit", "-m", "change readme");

		const result = await run((service) =>
			service.restoreFileToBase(folderId, "README.md"),
		);

		expect(result.restored).toBe(true);
		expect(git(repositoryRoot, "diff", "--", "README.md")).toContain("+first");
	});

	test("does not stage a conflict resolution while markers remain", async () => {
		const unresolved = [
			"<<<<<<< HEAD\n",
			"current\n",
			"=======\n",
			"incoming\n",
			">>>>>>> branch\n",
		].join("");
		writeFileSync(join(repositoryRoot, "README.md"), unresolved);

		await expect(
			run((service) =>
				service.resolveConflict(folderId, "README.md", unresolved),
			),
		).rejects.toMatchObject({
			_tag: "GitCommandError",
			folderId,
			reason: expect.stringContaining("markers remain"),
		});
		expect(readFileSync(join(repositoryRoot, "README.md"), "utf8")).toBe(
			unresolved,
		);
		expect(git(repositoryRoot, "diff", "--cached", "--name-only")).toBe("");
	});

	test("reports renamed, deleted, and binary files with review metadata", async () => {
		writeFileSync(join(repositoryRoot, "remove-me.txt"), "remove\n");
		git(repositoryRoot, "add", "remove-me.txt");
		git(repositoryRoot, "commit", "-m", "add fixture");
		git(repositoryRoot, "switch", "-c", "feature");
		git(repositoryRoot, "mv", "README.md", "README-renamed.md");
		git(repositoryRoot, "rm", "remove-me.txt");
		writeFileSync(join(repositoryRoot, "image.bin"), Buffer.from([0, 1, 2, 3]));
		git(repositoryRoot, "add", ".");

		const summary = await run((service) => service.reviewSummary(folderId));

		expect(summary.files).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					path: "README-renamed.md",
					oldPath: "README.md",
					kind: "renamed",
				}),
				expect.objectContaining({ path: "remove-me.txt", kind: "deleted" }),
				expect.objectContaining({ path: "image.bin", binary: true }),
			]),
		);
	});

	test("maps push failures to GitCommandError", async () => {
		await expect(
			run((service) => service.push(folderId)),
		).rejects.toMatchObject({ _tag: "GitCommandError", folderId });
	});

	test("emits an initial workspace barrier and coalesces filesystem changes", async () => {
		const framesPromise = run((service) =>
			service
				.workspaceChanges(folderId)
				.pipe(Stream.take(2), Stream.runCollect),
		);
		// Let the scoped watcher install before mutating the repository. The
		// production stream also has a five-second reconciliation fallback.
		await new Promise((resolve) => setTimeout(resolve, 25));
		writeFileSync(join(repositoryRoot, "README.md"), "changed\n");
		writeFileSync(join(repositoryRoot, "README.md"), "changed again\n");

		await expect(framesPromise).resolves.toEqual([
			{ revision: 0 },
			{ revision: 1 },
		]);
	}, 10_000);

	test("keeps reconciling when the native filesystem watcher fails or ends", async () => {
		const FailingWatchFileSystemLive = Layer.effect(
			FileSystem.FileSystem,
			Effect.map(FileSystem.FileSystem, (service) => ({
				...service,
				watch: () =>
					Stream.fail(
						new PlatformError.PlatformError(
							new PlatformError.SystemError({
								_tag: "Unknown",
								module: "FileSystem",
								method: "watch",
								description: "ENOSPC",
							}),
						),
					),
			})),
		);
		const PlatformLive = Layer.provideMerge(
			FailingWatchFileSystemLive,
			NodeServices.layer,
		);
		const EndingWatchFileSystemLive = Layer.effect(
			FileSystem.FileSystem,
			Effect.map(FileSystem.FileSystem, (service) => ({
				...service,
				watch: () => Stream.empty,
			})),
		);
		const EndingPlatformLive = Layer.provideMerge(
			EndingWatchFileSystemLive,
			NodeServices.layer,
		);

		await expect(
			Promise.all(
				[PlatformLive, EndingPlatformLive].map((platform) =>
					run(
						(service) =>
							service
								.workspaceChanges(folderId)
								.pipe(Stream.take(2), Stream.runCollect),
						makeLayer({ platform }),
					),
				),
			),
		).resolves.toEqual([
			[{ revision: 0 }, { revision: 1 }],
			[{ revision: 0 }, { revision: 1 }],
		]);
	}, 10_000);

	test("recovers one retained invalidation stream after folder and repository recovery", async () => {
		const recoveringRoot = join(temporaryRoot, "recovering-repository");
		mkdirSync(recoveringRoot);
		let folderAvailable = false;
		let resolveAttempts = 0;
		let watchStarts = 0;
		const RecoveringLocatorLive = Layer.succeed(RepositoryLocator, {
			root: () =>
				folderAvailable
					? Effect.succeed(recoveringRoot)
					: new GitFolderNotFoundError({ folderId }),
			worktreePath: () => Effect.succeed(null),
			resolve: () => {
				resolveAttempts += 1;
				return folderAvailable
					? Effect.succeed(recoveringRoot)
					: new GitFolderNotFoundError({ folderId });
			},
		});
		const CountingFileSystemLive = Layer.effect(
			FileSystem.FileSystem,
			Effect.map(FileSystem.FileSystem, (service) => ({
				...service,
				watch: (watchedPath: string) => {
					watchStarts += 1;
					return service.watch(watchedPath);
				},
			})),
		);
		const PlatformLive = Layer.provideMerge(
			CountingFileSystemLive,
			NodeServices.layer,
		);
		const layer = GitServiceLive.pipe(
			Layer.provide(RecoveringLocatorLive),
			Layer.provide(PlatformLive),
		);

		let streamSettled = false;
		const framesPromise = run(
			(service) =>
				service
					.workspaceChanges(folderId)
					.pipe(Stream.take(3), Stream.runCollect),
			layer,
		);
		void framesPromise.then(
			() => {
				streamSettled = true;
			},
			() => {
				streamSettled = true;
			},
		);
		for (
			let attempt = 0;
			attempt < 100 && resolveAttempts === 0;
			attempt += 1
		) {
			await new Promise((resolve) => setTimeout(resolve, 5));
		}
		expect(resolveAttempts).toBe(1);
		await new Promise((resolve) => setTimeout(resolve, 100));
		expect(resolveAttempts).toBe(1);
		expect(streamSettled).toBe(false);

		folderAvailable = true;
		await expect(
			run((service) => service.workspaceSnapshot(folderId), layer),
		).rejects.toMatchObject({ _tag: "GitNotARepoError", folderId });
		git(recoveringRoot, "init", "--initial-branch=main");
		git(recoveringRoot, "config", "user.name", "Test User");
		git(recoveringRoot, "config", "user.email", "test@example.com");
		writeFileSync(join(recoveringRoot, "README.md"), "recovered\n");
		git(recoveringRoot, "add", "README.md");
		git(recoveringRoot, "commit", "-m", "recover repository");

		for (let attempt = 0; attempt < 1_200 && watchStarts < 2; attempt += 1) {
			await new Promise((resolve) => setTimeout(resolve, 5));
		}
		expect(watchStarts).toBe(2);
		// `watch` is called while constructing the streams; give their native
		// subscriptions one turn to install before proving the fast path is live.
		await new Promise((resolve) => setTimeout(resolve, 50));
		const changedAt = Date.now();
		writeFileSync(join(recoveringRoot, "README.md"), "native watcher active\n");

		await expect(framesPromise).resolves.toEqual([
			{ revision: 0 },
			{ revision: 1 },
			{ revision: 2 },
		]);
		expect(Date.now() - changedAt).toBeLessThan(3_000);
	}, 12_000);

	test("shares one checkout watcher across concurrent subscribers", async () => {
		let watchStarts = 0;
		const CountingFileSystemLive = Layer.effect(
			FileSystem.FileSystem,
			Effect.map(FileSystem.FileSystem, (service) => ({
				...service,
				watch: (watchedPath: string) => {
					watchStarts += 1;
					return service.watch(watchedPath);
				},
			})),
		);
		const PlatformLive = Layer.provideMerge(
			CountingFileSystemLive,
			NodeServices.layer,
		);
		const framesPromise = run(
			(service) =>
				Effect.all(
					[
						service
							.workspaceChanges(folderId)
							.pipe(Stream.take(2), Stream.runCollect),
						service
							.workspaceChanges(folderId)
							.pipe(Stream.take(2), Stream.runCollect),
					],
					{ concurrency: 2 },
				),
			makeLayer({ platform: PlatformLive }),
		);
		for (let attempt = 0; attempt < 100 && watchStarts < 2; attempt += 1) {
			await new Promise((resolve) => setTimeout(resolve, 5));
		}
		expect(watchStarts).toBe(2);
		writeFileSync(join(repositoryRoot, "README.md"), "shared watcher\n");

		const [first, second] = await framesPromise;
		expect(first).toEqual([{ revision: 0 }, { revision: 1 }]);
		expect(second).toEqual([{ revision: 0 }, { revision: 1 }]);
		expect(watchStarts).toBe(2);
	}, 10_000);

	test("keeps delimiter-ambiguous checkout identities isolated", async () => {
		const secondRepositoryRoot = join(temporaryRoot, "repository-two");
		mkdirSync(secondRepositoryRoot);
		git(secondRepositoryRoot, "init", "--initial-branch=main");
		git(secondRepositoryRoot, "config", "user.name", "Test User");
		git(secondRepositoryRoot, "config", "user.email", "test@example.com");
		writeFileSync(join(secondRepositoryRoot, "README.md"), "second\n");
		git(secondRepositoryRoot, "add", "README.md");
		git(secondRepositoryRoot, "commit", "-m", "second repository");

		const firstFolderId = FolderId.make("repository");
		const firstWorktreeId = WorktreeId.make("one:two");
		const secondFolderId = FolderId.make("repository:one");
		const secondWorktreeId = WorktreeId.make("two");
		const watchedPaths = new Set<string>();
		const CountingFileSystemLive = Layer.effect(
			FileSystem.FileSystem,
			Effect.map(FileSystem.FileSystem, (service) => ({
				...service,
				watch: (watchedPath: string) => {
					watchedPaths.add(watchedPath);
					return service.watch(watchedPath);
				},
			})),
		);
		const PlatformLive = Layer.provideMerge(
			CountingFileSystemLive,
			NodeServices.layer,
		);
		const LocatorLive = Layer.succeed(RepositoryLocator, {
			root: (requestedFolderId) =>
				Effect.succeed(
					requestedFolderId === firstFolderId
						? repositoryRoot
						: secondRepositoryRoot,
				),
			worktreePath: () => Effect.succeed(null),
			resolve: (requestedFolderId) =>
				Effect.succeed(
					requestedFolderId === firstFolderId
						? repositoryRoot
						: secondRepositoryRoot,
				),
		});
		const layer = GitServiceLive.pipe(
			Layer.provide(LocatorLive),
			Layer.provide(PlatformLive),
		);

		const framesPromise = run(
			(service) =>
				Effect.all(
					[
						service
							.workspaceChanges(firstFolderId, firstWorktreeId)
							.pipe(Stream.take(2), Stream.runCollect),
						service
							.workspaceChanges(secondFolderId, secondWorktreeId)
							.pipe(Stream.take(2), Stream.runCollect),
					],
					{ concurrency: 2 },
				),
			layer,
		);
		for (
			let attempt = 0;
			attempt < 200 &&
			(!watchedPaths.has(repositoryRoot) ||
				!watchedPaths.has(secondRepositoryRoot));
			attempt += 1
		) {
			await new Promise((resolve) => setTimeout(resolve, 5));
		}

		expect(watchedPaths.has(repositoryRoot)).toBe(true);
		expect(watchedPaths.has(secondRepositoryRoot)).toBe(true);
		// `watch` is invoked while building each stream; allow both native
		// subscriptions to finish installing before generating their events.
		await new Promise((resolve) => setTimeout(resolve, 50));
		writeFileSync(join(repositoryRoot, "README.md"), "first changed\n");
		writeFileSync(join(secondRepositoryRoot, "README.md"), "second changed\n");
		await expect(framesPromise).resolves.toEqual([
			[{ revision: 0 }, { revision: 1 }],
			[{ revision: 0 }, { revision: 1 }],
		]);
	}, 10_000);

	test("starts a fresh revision epoch after the shared checkout stream goes idle", async () => {
		await run((service) =>
			Effect.gen(function* () {
				const first = yield* Effect.forkChild(
					service
						.workspaceChanges(folderId)
						.pipe(Stream.take(2), Stream.runCollect),
				);
				yield* Effect.sleep("25 millis");
				writeFileSync(join(repositoryRoot, "README.md"), "first epoch\n");
				expect(yield* Fiber.join(first)).toEqual([
					{ revision: 0 },
					{ revision: 1 },
				]);

				yield* Effect.sleep("2100 millis");
				const second = yield* service
					.workspaceChanges(folderId)
					.pipe(Stream.take(1), Stream.runCollect);
				expect(second).toEqual([{ revision: 0 }]);
			}),
		);
	}, 10_000);

	test("releases checkout sharing state after the last subscriber goes idle", async () => {
		await Effect.runPromise(
			Effect.gen(function* () {
				const streams = yield* makeWorkspaceChangeStreams(() =>
					Stream.make({ revision: 0 }),
				);
				yield* streams
					.stream(folderId, null)
					.pipe(Stream.take(1), Stream.runDrain);
				expect(yield* streams.retainedCheckoutCount).toBe(1);

				yield* Effect.sleep("2100 millis");
				expect(yield* streams.retainedCheckoutCount).toBe(0);
			}).pipe(Effect.scoped),
		);
	}, 10_000);

	test("invalidates a linked worktree when its Git metadata changes", async () => {
		const worktreeRoot = join(temporaryRoot, "watched-worktree");
		git(repositoryRoot, "worktree", "add", "-b", "before-rename", worktreeRoot);
		const framesPromise = run(
			(service) =>
				service
					.workspaceChanges(folderId, worktreeId)
					.pipe(Stream.take(2), Stream.runCollect),
			makeLayer({ worktreePath: worktreeRoot }),
		);
		await new Promise((resolve) => setTimeout(resolve, 25));
		git(worktreeRoot, "branch", "-m", "after-rename");

		await expect(framesPromise).resolves.toEqual([
			{ revision: 0 },
			{ revision: 1 },
		]);
	}, 10_000);

	test("maps a missing git executable to GitNotInstalledError", async () => {
		const MissingSpawnerLive = Layer.succeed(
			ChildProcessSpawner.ChildProcessSpawner,
			ChildProcessSpawner.make(() =>
				Effect.fail(
					new PlatformError.PlatformError(
						new PlatformError.SystemError({
							_tag: "NotFound",
							module: "test",
							method: "spawn",
						}),
					),
				),
			),
		);
		const PlatformLive = Layer.mergeAll(
			NodeFileSystem.layer,
			NodePath.layer,
			MissingSpawnerLive,
		);

		await expect(
			run(
				(service) => service.status(folderId),
				makeLayer({ platform: PlatformLive }),
			),
		).rejects.toMatchObject({ _tag: "GitNotInstalledError" });
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

	test("previews local commits and rejects a stale reset-to-remote apply", async () => {
		const remote = join(temporaryRoot, "remote.git");
		git(temporaryRoot, "init", "--bare", remote);
		git(repositoryRoot, "remote", "add", "origin", remote);
		git(repositoryRoot, "push", "-u", "origin", "main");
		writeFileSync(join(repositoryRoot, "README.md"), "local commit\n");
		git(repositoryRoot, "add", "README.md");
		git(repositoryRoot, "commit", "-m", "local-only change");

		const preview = await run((service) =>
			service.resetRemotePreview(folderId),
		);
		expect(preview.commitsToDiscard).toEqual([
			expect.objectContaining({ subject: "local-only change" }),
		]);

		writeFileSync(join(repositoryRoot, "README.md"), "changed after preview\n");
		await expect(
			run((service) =>
				service.resetRemoteApply(
					folderId,
					preview.currentHead,
					preview.remoteHead,
					preview.worktreeFingerprint,
					preview.branch,
				),
			),
		).rejects.toMatchObject({ _tag: "GitStalePreviewError" });
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
