import {
	type TurnInterruptReceipt,
	TurnInterruptReceipt as TurnInterruptReceiptSchema,
} from "@zuse/contracts";
import { KeyedEffectSerialWorker } from "@zuse/utils/keyed-worker";
import { Effect, Result, Schema } from "effect";

import type { SessionCommand } from "../core/commands.js";
import {
	type DomainError,
	decide,
	turnInterruptReceipt,
} from "../core/decider.js";
import type { SessionEvent } from "../core/events.js";
import { evolveAll, initialSessionState } from "../core/state.js";

export type StoredEvent<Event = SessionEvent> = {
	readonly eventId: string;
	readonly correlationId: string;
	readonly causationEventId: string | null;
	readonly streamId: string;
	readonly streamVersion: number;
	readonly sequence: number;
	readonly event: Event;
};

/**
 * Optional transport identity committed in the same transaction as a command
 * receipt. A missing identity denotes a receipt written by a pre-v3 caller and
 * may be bound only after the caller verifies the receipt's durable events.
 */
export const CommandReceiptIdentity = Schema.Struct({
	fingerprint: Schema.String,
	commandKind: Schema.String,
	schemaVersion: Schema.Number,
	storageIncarnationId: Schema.String,
});
export type CommandReceiptIdentity = typeof CommandReceiptIdentity.Type;

export const CommandReceipt = Schema.Struct({
	commandId: Schema.String,
	streamId: Schema.String,
	streamVersion: Schema.Number,
	eventIds: Schema.Array(Schema.String),
	result: Schema.optional(TurnInterruptReceiptSchema),
	receiptIdentity: Schema.optional(CommandReceiptIdentity),
});
export type CommandReceipt = typeof CommandReceipt.Type;

export type DispatchInput<Command = SessionCommand> = {
	readonly commandId: string;
	readonly streamId: string;
	readonly correlationId?: string;
	readonly causationEventId?: string;
	readonly receiptIdentity?: CommandReceiptIdentity;
	readonly command: Command;
};

export class CommandReceiptConflict extends Schema.TaggedErrorClass<CommandReceiptConflict>()(
	"CommandReceiptConflict",
	{
		commandId: Schema.String,
		expectedStreamId: Schema.String,
		actualStreamId: Schema.String,
	},
) {}

export class CommandReceiptIdentityConflict extends Schema.TaggedErrorClass<CommandReceiptIdentityConflict>()(
	"CommandReceiptIdentityConflict",
	{
		commandId: Schema.String,
	},
) {}

export type AppendInput<Event = SessionEvent> = {
	readonly commandId: string;
	readonly streamId: string;
	readonly correlationId: string;
	readonly causationEventId: string | null;
	readonly expectedVersion: number;
	readonly events: readonly {
		readonly eventId: string;
		readonly event: Event;
	}[];
	readonly result?: TurnInterruptReceipt;
	readonly receiptIdentity?: CommandReceiptIdentity;
};

const sameReceiptIdentity = (
	left: CommandReceiptIdentity,
	right: CommandReceiptIdentity,
): boolean =>
	left.fingerprint === right.fingerprint &&
	left.commandKind === right.commandKind &&
	left.schemaVersion === right.schemaVersion &&
	left.storageIncarnationId === right.storageIncarnationId;

export const validateCommandReceipt = <Command>(
	input: DispatchInput<Command>,
	receipt: CommandReceipt,
): Effect.Effect<
	CommandReceipt,
	CommandReceiptConflict | CommandReceiptIdentityConflict
> => {
	if (receipt.streamId !== input.streamId) {
		return Effect.fail(
			new CommandReceiptConflict({
				commandId: input.commandId,
				expectedStreamId: input.streamId,
				actualStreamId: receipt.streamId,
			}),
		);
	}
	if (
		input.receiptIdentity !== undefined &&
		receipt.receiptIdentity !== undefined &&
		!sameReceiptIdentity(input.receiptIdentity, receipt.receiptIdentity)
	) {
		return Effect.fail(
			new CommandReceiptIdentityConflict({ commandId: input.commandId }),
		);
	}
	return Effect.succeed(receipt);
};

export interface DispatchStorage<StorageError = never, Event = SessionEvent> {
	receipt(
		commandId: string,
	): Effect.Effect<CommandReceipt | null, StorageError>;
	events(
		streamId: string,
	): Effect.Effect<readonly StoredEvent<Event>[], StorageError>;
	append(
		input: AppendInput<Event>,
	): Effect.Effect<CommandReceipt, StorageError>;
}

export class ConcurrencyConflict extends Schema.TaggedErrorClass<ConcurrencyConflict>()(
	"ConcurrencyConflict",
	{
		streamId: Schema.String,
		expectedVersion: Schema.Number,
		actualVersion: Schema.Number,
	},
) {}

export class DispatchEngine<
	StorageError = never,
	EventIdError = never,
	EventIdRequirements = never,
> {
	private readonly worker = new KeyedEffectSerialWorker<string>();

	constructor(
		private readonly storage: DispatchStorage<StorageError>,
		private readonly makeEventId: () => Effect.Effect<
			string,
			EventIdError,
			EventIdRequirements
		>,
	) {}

	dispatch(
		input: DispatchInput,
	): Effect.Effect<
		CommandReceipt,
		DispatchFailure<StorageError> | EventIdError,
		EventIdRequirements
	> {
		return this.worker.run(input.streamId, this.run(input));
	}

	private readonly run = Effect.fn("DispatchEngine.run")(function* (
		this: DispatchEngine<StorageError, EventIdError, EventIdRequirements>,
		input: DispatchInput,
	) {
		const existing = yield* this.storage.receipt(input.commandId);
		if (existing !== null)
			return yield* validateCommandReceipt(input, existing);

		const stored = yield* this.storage.events(input.streamId);
		const state = evolveAll(
			initialSessionState,
			stored.map((record) => record.event),
		);
		const decision = decide(state, input.command);
		if (Result.isFailure(decision)) return yield* decision.failure;

		const events = yield* Effect.forEach(decision.success, (event) =>
			this.makeEventId().pipe(Effect.map((eventId) => ({ eventId, event }))),
		);

		return yield* this.storage.append({
			commandId: input.commandId,
			streamId: input.streamId,
			correlationId: input.correlationId ?? input.commandId,
			causationEventId: input.causationEventId ?? null,
			expectedVersion: state.version,
			events,
			...(input.command._tag === "RequestTurnInterrupt"
				? {
						result: turnInterruptReceipt(state, input.command.expectedTurnId),
					}
				: {}),
			...(input.receiptIdentity === undefined
				? {}
				: { receiptIdentity: input.receiptIdentity }),
		});
	});
}

export class InMemoryDispatchStorage
	implements
		DispatchStorage<
			| ConcurrencyConflict
			| CommandReceiptConflict
			| CommandReceiptIdentityConflict
		>
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
		if (existing !== undefined)
			return yield* validateCommandReceipt(
				{
					commandId: input.commandId,
					streamId: input.streamId,
					command: undefined,
					...(input.receiptIdentity === undefined
						? {}
						: { receiptIdentity: input.receiptIdentity }),
				},
				existing,
			);
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
			...(input.result === undefined ? {} : { result: input.result }),
			...(input.receiptIdentity === undefined
				? {}
				: { receiptIdentity: input.receiptIdentity }),
		};
		this.receipts.set(input.commandId, receipt);
		return receipt;
	});
}

export type DispatchFailure<StorageError = never> =
	| DomainError
	| ConcurrencyConflict
	| CommandReceiptConflict
	| CommandReceiptIdentityConflict
	| StorageError;
