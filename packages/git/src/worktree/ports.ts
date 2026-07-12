import type { FolderId, PokemonSummary, WorktreeId } from "@zuse/contracts";
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

export interface WorktreeNameAllocation {
	readonly name: string;
	readonly pokemonNumber: number;
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

export class WorktreeNameAllocator extends Context.Service<
	WorktreeNameAllocator,
	{
		readonly allocate: (input: {
			readonly unavailableNames: ReadonlySet<string>;
			readonly usedPokemonNumbers: ReadonlySet<number>;
		}) => Effect.Effect<WorktreeNameAllocation | null>;
	}
>()("zuse/git/worktree/WorktreeNameAllocator") {}

export class PokemonAssignment extends Context.Service<
	PokemonAssignment,
	{
		readonly record: (
			pokemonNumber: number,
			worktreeId: WorktreeId,
		) => Effect.Effect<void>;
	}
>()("zuse/git/worktree/PokemonAssignment") {}

export class WorktreeDecoration extends Context.Service<
	WorktreeDecoration,
	{
		readonly pokemonSummary: (
			pokemonNumber: number | null,
			worktreeName: string,
		) => PokemonSummary | null;
	}
>()("zuse/git/worktree/WorktreeDecoration") {}
