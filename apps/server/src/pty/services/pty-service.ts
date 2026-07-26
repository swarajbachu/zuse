import type {
	PtyCommand,
	PtyEvent,
	PtyId,
	PtyMobileOwnership,
	PtyNotFoundError,
	PtyOwnerLimitError,
	PtyOwnerMismatchError,
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
		mobileOwnership?: PtyMobileOwnership,
	) => Effect.Effect<
		{ readonly ptyId: PtyId },
		PtySpawnError | PtyOwnerLimitError
	>;
	readonly list: (ownerId: string) => Effect.Effect<ReadonlyArray<PtySummary>>;
	readonly write: (
		ptyId: PtyId,
		data: string,
		ownerId?: string,
	) => Effect.Effect<void, PtyNotFoundError | PtyOwnerMismatchError>;
	readonly resize: (
		ptyId: PtyId,
		cols: number,
		rows: number,
		ownerId?: string,
	) => Effect.Effect<void, PtyNotFoundError | PtyOwnerMismatchError>;
	readonly close: (
		ptyId: PtyId,
		ownerId?: string,
	) => Effect.Effect<void, PtyNotFoundError | PtyOwnerMismatchError>;
	readonly closeByCwdPrefix: (cwdPrefix: string) => Effect.Effect<void>;
	readonly subscribe: (
		ptyId: PtyId,
		afterSequence?: number,
		ownerId?: string,
	) => Stream.Stream<
		typeof PtyEvent.Type,
		PtyNotFoundError | PtyOwnerMismatchError
	>;
}

export class PtyService extends Context.Service<PtyService, PtyServiceShape>()(
	"memoize/PtyService",
) {}
