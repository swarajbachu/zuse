import type {
	Folder,
	FolderId,
	WorkspaceDuplicatePathError,
	WorkspaceInvalidPathError,
	WorkspaceKey,
	WorkspaceNotFoundError,
} from "@zuse/contracts";
import { Context, type Effect, type Stream } from "effect";

export interface WorkspaceAddOptions {
	/** Owning workspace for a new row. Defaults to Personal. */
	readonly workspaceKey?: WorkspaceKey;
	/** Reassign an existing row only while it still belongs to this workspace. */
	readonly moveFrom?: WorkspaceKey;
}

export interface WorkspaceServiceShape {
	readonly add: (
		path: string,
		options?: WorkspaceAddOptions,
	) => Effect.Effect<
		Folder,
		WorkspaceDuplicatePathError | WorkspaceInvalidPathError
	>;
	readonly list: () => Effect.Effect<ReadonlyArray<Folder>>;
	readonly streamChanges: () => Stream.Stream<ReadonlyArray<Folder>>;
	readonly remove: (
		folderId: FolderId,
	) => Effect.Effect<void, WorkspaceNotFoundError>;
	readonly getSelected: () => Effect.Effect<FolderId | null>;
	readonly setSelected: (folderId: FolderId | null) => Effect.Effect<void>;
	readonly findById: (folderId: FolderId) => Effect.Effect<Folder | null>;
}

export class WorkspaceService extends Context.Service<
	WorkspaceService,
	WorkspaceServiceShape
>()("memoize/WorkspaceService") {}
