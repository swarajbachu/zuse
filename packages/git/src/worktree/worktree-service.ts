import type {
	FolderId,
	Worktree,
	WorktreeArchiveSnapshot,
	WorktreeBranchRenameError,
	WorktreeCheckpointError,
	WorktreeCreateError,
	WorktreeCreateSource,
	WorktreeId,
	WorktreeNotFoundError,
	WorktreeRemoveError,
	WorktreeRestoreError,
	WorktreeSetupError,
	WorktreeSetupEvent,
} from "@zuse/contracts";
import { Context, type Effect, type Stream } from "effect";

export type WorktreeRestoreSnapshot = WorktreeArchiveSnapshot;

export interface WorktreeArchiveOutcome {
	readonly archiveCommit: string;
	readonly checkpointCreated: boolean;
	readonly archiveRef: string | null;
	readonly archivedContextPath: string | null;
	readonly branch: string;
	readonly detachedHead: boolean;
	readonly branchProvenance: "pending" | "automatic" | "manual";
	readonly pokemonNumber: number | null;
}

export interface WorktreeRestoreOutcome {
	readonly worktree: Worktree;
	readonly checkpoint:
		| "applied"
		| "none"
		| "branch-advanced"
		| "already-present";
}

export interface WorktreeServiceShape {
	readonly create: (
		projectId: FolderId,
		source?: WorktreeCreateSource,
		requestedId?: WorktreeId,
	) => Effect.Effect<Worktree, WorktreeCreateError>;
	readonly list: (
		projectId: FolderId,
	) => Effect.Effect<ReadonlyArray<Worktree>>;
	readonly get: (worktreeId: WorktreeId) => Effect.Effect<Worktree | null>;
	readonly renameBranch: (
		worktreeId: WorktreeId,
		name: string,
		provenance: "automatic" | "manual",
	) => Effect.Effect<
		Worktree,
		WorktreeNotFoundError | WorktreeBranchRenameError
	>;
	readonly archive: (
		worktreeId: WorktreeId,
		recordCheckpoint?: (
			outcome: WorktreeArchiveOutcome,
		) => Effect.Effect<void, WorktreeCheckpointError>,
		allowRemoval?: () => Effect.Effect<boolean>,
	) => Effect.Effect<
		WorktreeArchiveOutcome,
		WorktreeNotFoundError | WorktreeCheckpointError | WorktreeRemoveError
	>;
	readonly remove: (
		worktreeId: WorktreeId,
	) => Effect.Effect<
		void,
		WorktreeNotFoundError | WorktreeCheckpointError | WorktreeRemoveError
	>;
	readonly rerunSetup: (
		worktreeId: WorktreeId,
	) => Effect.Effect<
		Worktree,
		WorktreeNotFoundError | WorktreeSetupError | WorktreeRemoveError
	>;
	/**
	 * Subscribe to a worktree's live setup output + status transitions. Seeds
	 * the current persisted snapshot on subscribe; completes once setup reaches
	 * a terminal status.
	 */
	readonly setupStream: (
		worktreeId: WorktreeId,
	) => Stream.Stream<WorktreeSetupEvent, WorktreeNotFoundError>;
	readonly startRun: (worktreeId: WorktreeId) => Effect.Effect<
		{
			readonly cwd: string;
			readonly script: string;
			readonly env: Record<string, string>;
		},
		WorktreeNotFoundError | WorktreeSetupError
	>;
	readonly restore: (
		snapshot: WorktreeRestoreSnapshot,
	) => Effect.Effect<WorktreeRestoreOutcome, WorktreeRestoreError>;
}

export class WorktreeService extends Context.Service<
	WorktreeService,
	WorktreeServiceShape
>()("memoize/WorktreeService") {}
