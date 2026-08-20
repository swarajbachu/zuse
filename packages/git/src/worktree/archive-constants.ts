import type { WorktreeId } from "@zuse/contracts";

export const ARCHIVE_CHECKPOINT_MESSAGE = "zuse: archive checkpoint";

export const archiveCheckpointTrailer = (worktreeId: WorktreeId): string =>
	`Zuse-Archive-Checkpoint: ${worktreeId}`;

export const archiveRefForWorktree = (worktreeId: WorktreeId): string =>
	`refs/zuse/archive/${worktreeId}`;
