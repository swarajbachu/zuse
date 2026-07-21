import { GitFolderNotFoundError, type WorktreeId } from "@zuse/contracts";
import { RepositoryLocator } from "@zuse/git/repository-locator";
import { WorktreeService } from "@zuse/git/worktree-service";
import { Effect, FileSystem, Layer } from "effect";
import { WorkspaceService } from "../workspace/services/workspace-service.ts";

export const RepositoryLocatorLive = Layer.effect(
	RepositoryLocator,
	Effect.gen(function* () {
		const workspace = yield* WorkspaceService;
		const worktrees = yield* WorktreeService;
		const fs = yield* FileSystem.FileSystem;

		const root: RepositoryLocator["Service"]["root"] = (folderId) =>
			workspace.findById(folderId).pipe(
				Effect.flatMap((folder) =>
					folder === null
						? new GitFolderNotFoundError({ folderId })
						: fs.exists(folder.path).pipe(
								Effect.flatMap((exists) =>
									exists
										? Effect.succeed(folder.path)
										: new GitFolderNotFoundError({ folderId }),
								),
								Effect.catch(() =>
									Effect.fail(new GitFolderNotFoundError({ folderId })),
								),
							),
				),
			);

		const worktree = (worktreeId: WorktreeId) => worktrees.get(worktreeId);

		return RepositoryLocator.of({
			root,
			worktreePath: (worktreeId) =>
				worktree(worktreeId).pipe(Effect.map((entry) => entry?.path ?? null)),
			resolve: (folderId, worktreeId) =>
				Effect.gen(function* () {
					const repositoryRoot = yield* root(folderId);
					if (worktreeId === null || worktreeId === undefined) {
						return repositoryRoot;
					}
					const entry = yield* worktree(worktreeId);
					if (entry?.projectId !== folderId) {
						return yield* Effect.fail(new GitFolderNotFoundError({ folderId }));
					}
					const exists = yield* fs
						.exists(entry.path)
						.pipe(Effect.orElseSucceed(() => false));
					if (!exists) {
						return yield* Effect.fail(new GitFolderNotFoundError({ folderId }));
					}
					return entry.path;
				}),
		});
	}),
);
