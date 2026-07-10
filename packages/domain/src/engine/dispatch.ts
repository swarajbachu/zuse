import { KeyedEffectSerialWorker } from "@zuse/utils/keyed-worker";
import { Effect, Result, Schema } from "effect";

import type { SessionCommand } from "../core/commands.js";
import { type DomainError, decide } from "../core/decider.js";
import type { SessionEvent } from "../core/events.js";
import { evolveAll, initialSessionState } from "../core/state.js";

export type StoredEvent = {
	readonly eventId: string;
	readonly correlationId: string;
	readonly causationEventId: string | null;
	readonly streamId: string;
	readonly streamVersion: number;
	readonly sequence: number;
	readonly event: SessionEvent;
};

export const CommandReceipt = Schema.Struct({
	commandId: Schema.String,
	streamId: Schema.String,
	streamVersion: Schema.Number,
	eventIds: Schema.Array(Schema.String),
});
export type CommandReceipt = typeof CommandReceipt.Type;

export type DispatchInput = {
	readonly commandId: string;
	readonly streamId: string;
	readonly correlationId?: string;
	readonly causationEventId?: string;
	readonly command: SessionCommand;
};

export type AppendInput = {
	readonly commandId: string;
	readonly streamId: string;
	readonly correlationId: string;
	readonly causationEventId: string | null;
	readonly expectedVersion: number;
	readonly events: readonly {
		readonly eventId: string;
		readonly event: SessionEvent;
	}[];
};

export interface DispatchStorage<StorageError = never> {
	receipt(
		commandId: string,
	): Effect.Effect<CommandReceipt | null, StorageError>;
	events(streamId: string): Effect.Effect<readonly StoredEvent[], StorageError>;
	append(input: AppendInput): Effect.Effect<CommandReceipt, StorageError>;
}

export class ConcurrencyConflict extends Schema.TaggedErrorClass<ConcurrencyConflict>()(
	"ConcurrencyConflict",
	{
		streamId: Schema.String,
		expectedVersion: Schema.Number,
		actualVersion: Schema.Number,
	},
) {}

export class DispatchEngine<StorageError = never> {
	private readonly worker = new KeyedEffectSerialWorker<string>();

	constructor(
		private readonly storage: DispatchStorage<StorageError>,
		private readonly makeEventId: () => string,
	) {}

	dispatch(
		input: DispatchInput,
	): Effect.Effect<CommandReceipt, DispatchFailure<StorageError>> {
		return this.worker.run(input.streamId, this.run(input));
	}

	private readonly run = Effect.fn("DispatchEngine.run")(function* (
		this: DispatchEngine<StorageError>,
		input: DispatchInput,
	) {
		const existing = yield* this.storage.receipt(input.commandId);
		if (existing !== null) return existing;

		const stored = yield* this.storage.events(input.streamId);
		const state = evolveAll(
			initialSessionState,
			stored.map((record) => record.event),
		);
		const decision = decide(state, input.command);
		if (Result.isFailure(decision)) return yield* decision.failure;

		return yield* this.storage.append({
			commandId: input.commandId,
			streamId: input.streamId,
			correlationId: input.correlationId ?? input.commandId,
			causationEventId: input.causationEventId ?? null,
			expectedVersion: state.version,
			events: decision.success.map((event) => ({
				eventId: this.makeEventId(),
				event,
			})),
		});
	});
}

export class InMemoryDispatchStorage
	implements DispatchStorage<ConcurrencyConflict>
{
	private readonly eventLog: StoredEvent[] = [];
	private readonly receipts = new Map<string, CommandReceipt>();

	receipt(commandId: string): Effect.Effect<CommandReceipt | null> {
		return Effect.sync(() => this.receipts.get(commandId) ?? null);
	}

	events(streamId: string): Effect.Effect<readonly StoredEvent[]> {
		return Effect.sync(() => this.eventsFor(streamId));
	}

	eventsFor(streamId: string): readonly StoredEvent[] {
		return this.eventLog.filter((record) => record.streamId === streamId);
	}

	readonly append = Effect.fn("InMemoryDispatchStorage.append")(function* (
		this: InMemoryDispatchStorage,
		input: AppendInput,
	) {
		const existing = this.receipts.get(input.commandId);
		if (existing !== undefined) return existing;
		const actualVersion = this.eventsFor(input.streamId).length;
		if (actualVersion !== input.expectedVersion) {
			return yield* new ConcurrencyConflict({
				streamId: input.streamId,
				expectedVersion: input.expectedVersion,
				actualVersion,
			});
		}
		const eventIds: string[] = [];
		let streamVersion = input.expectedVersion;
		for (const item of input.events) {
			eventIds.push(item.eventId);
			streamVersion += 1;
			this.eventLog.push({
				eventId: item.eventId,
				correlationId: input.correlationId,
				causationEventId: input.causationEventId,
				streamId: input.streamId,
				streamVersion,
				sequence: this.eventLog.length + 1,
				event: item.event,
			});
		}
		const receipt: CommandReceipt = {
			commandId: input.commandId,
			streamId: input.streamId,
			streamVersion,
			eventIds,
		};
		this.receipts.set(input.commandId, receipt);
		return receipt;
	});
}

export type DispatchFailure<StorageError = never> =
	| DomainError
	| ConcurrencyConflict
	| StorageError;
