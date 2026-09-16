import type {
	PtyCatalog,
	PtyCommand,
	PtyEvent,
	PtyId,
	PtyNotFoundError,
	PtyOpenConflictError,
	PtyOwnerId,
	PtyOwnerLimitError,
	PtyOwnerMismatchError,
	PtyOwnership,
	PtySpawnError,
	PtySummary,
} from "@zuse/contracts";
import { Context, type Effect, type Stream } from "effect";

export interface PtyServiceShape {
	readonly open: (
		cwd: string,
		cols: number,
		rows: number,
		command?: PtyCommand,
		ownership?: PtyOwnership,
	) => Effect.Effect<
		{ readonly ptyId: PtyId; readonly processEpoch: string },
		PtySpawnError | PtyOwnerLimitError | PtyOpenConflictError
	>;
	readonly list: (ownerId: PtyOwnerId) => Effect.Effect<PtyCatalog>;
	readonly write: (
		ptyId: PtyId,
		data: string,
		ownerId?: PtyOwnerId,
	) => Effect.Effect<void, PtyNotFoundError | PtyOwnerMismatchError>;
	readonly resize: (
		ptyId: PtyId,
		cols: number,
		rows: number,
		ownerId?: PtyOwnerId,
	) => Effect.Effect<void, PtyNotFoundError | PtyOwnerMismatchError>;
	readonly close: (
		ptyId: PtyId,
		ownerId?: PtyOwnerId,
	) => Effect.Effect<void, PtyNotFoundError | PtyOwnerMismatchError>;
	readonly closeOwned: (ownerId: PtyOwnerId) => Effect.Effect<number>;
	readonly rename: (
		ptyId: PtyId,
		label: string | null,
		ownerId?: PtyOwnerId,
	) => Effect.Effect<PtySummary, PtyNotFoundError | PtyOwnerMismatchError>;
	readonly restart: (
		ptyId: PtyId,
		ownerId?: PtyOwnerId,
		expectedProcessEpoch?: string,
	) => Effect.Effect<
		{ readonly ptyId: PtyId; readonly processEpoch: string },
		| PtyNotFoundError
		| PtyOwnerMismatchError
		| PtySpawnError
		| PtyOwnerLimitError
	>;
	readonly closeByCwdPrefix: (cwdPrefix: string) => Effect.Effect<void>;
	readonly subscribe: (
		ptyId: PtyId,
		afterSequence?: number,
		processEpoch?: string,
		ownerId?: PtyOwnerId,
	) => Stream.Stream<
		typeof PtyEvent.Type,
		PtyNotFoundError | PtyOwnerMismatchError
	>;
}

export class PtyService extends Context.Service<PtyService, PtyServiceShape>()(
	"memoize/PtyService",
) {}
