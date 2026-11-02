import type { FolderId } from "@zuse/contracts";
import { Context, type Effect } from "effect";

export interface ProjectLocation {
	readonly id: FolderId;
	readonly name: string;
	readonly path: string;
}

export interface WorktreeRepositorySettings {
	readonly worktreeBaseDir: string | null;
	readonly setupScript: string | null;
	readonly runScript: string | null;
	readonly environmentVariables: Readonly<Record<string, string>>;
	readonly fileIncludeGlobs: string;
}

export class ProjectLocator extends Context.Service<
	ProjectLocator,
	{
		readonly find: (
			projectId: FolderId,
		) => Effect.Effect<ProjectLocation | null>;
	}
>()("zuse/git/worktree/ProjectLocator") {}

export class RepositorySettingsReader extends Context.Service<
	RepositorySettingsReader,
	{
		readonly get: (
			projectId: FolderId,
		) => Effect.Effect<WorktreeRepositorySettings>;
	}
>()("zuse/git/worktree/RepositorySettingsReader") {}

export interface WorktreeNameAllocation {
	/** Folder name: a single path segment. */
	readonly name: string;
	readonly branch: string;
}

export class WorktreeNameAllocator extends Context.Service<
	WorktreeNameAllocator,
	{
		/**
		 * A placeholder folder and branch for a new worktree, or null when none
		 * is free. Chats replace the branch once their first turn is named.
		 */
		readonly allocate: (input: {
			readonly unavailableNames: ReadonlySet<string>;
		}) => Effect.Effect<WorktreeNameAllocation | null>;
	}
>()("zuse/git/worktree/WorktreeNameAllocator") {}
