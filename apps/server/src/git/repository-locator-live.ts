import { GitFolderNotFoundError, type WorktreeId } from "@zuse/contracts";
import { RepositoryLocator } from "@zuse/git/repository-locator";
import { WorktreeService } from "@zuse/git/worktree-service";
import { Effect, Layer } from "effect";
import { WorkspaceService } from "../workspace/services/workspace-service.ts";

export const RepositoryLocatorLive = Layer.effect(
	RepositoryLocator,
	Effect.gen(function* () {
		const workspace = yield* WorkspaceService;
		const worktrees = yield* WorktreeService;

		const root: RepositoryLocator["Service"]["root"] = (folderId) =>
			workspace
				.findById(folderId)
				.pipe(
					Effect.flatMap((folder) =>
						folder === null
							? new GitFolderNotFoundError({ folderId })
							: Effect.succeed(folder.path),
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
					return entry?.projectId === folderId ? entry.path : repositoryRoot;
				}),
		});
	}),
);
