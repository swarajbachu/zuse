import type {
	FolderId,
	GitFolderNotFoundError,
	WorktreeId,
} from "@zuse/contracts";
import { Context, type Effect } from "effect";

export interface RepositoryLocatorShape {
	readonly root: (
		folderId: FolderId,
	) => Effect.Effect<string, GitFolderNotFoundError>;
	readonly worktreePath: (
		worktreeId: WorktreeId,
	) => Effect.Effect<string | null>;
	readonly resolve: (
		folderId: FolderId,
		worktreeId?: WorktreeId | null,
	) => Effect.Effect<string, GitFolderNotFoundError>;
}

/** Resolves application repository identities to filesystem paths. */
export class RepositoryLocator extends Context.Service<
	RepositoryLocator,
	RepositoryLocatorShape
>()("zuse/git/RepositoryLocator") {}
