import { KeyedEffectSerialWorker } from "@zuse/utils/keyed-worker";
import { Effect, Result } from "effect";

import type {
	AppendInput,
	CommandReceipt,
	DispatchInput,
	DispatchStorage,
} from "./dispatch.js";

export type AggregateDefinition<State, Command, Event, DomainError> = {
	readonly initialState: State;
	readonly version: (state: State) => number;
	readonly evolveAll: (state: State, events: readonly Event[]) => State;
	readonly decide: (
		state: State,
		command: Command,
	) => Result.Result<readonly Event[], DomainError>;
};

export class AggregateDispatchEngine<
	State,
	Command,
	Event,
	DomainError,
	StorageError = never,
	EventIdError = never,
	EventIdRequirements = never,
> {
	private readonly worker = new KeyedEffectSerialWorker<string>();

	constructor(
		private readonly storage: DispatchStorage<StorageError, Event>,
		private readonly aggregate: AggregateDefinition<
			State,
			Command,
			Event,
			DomainError
		>,
		private readonly makeEventId: () => Effect.Effect<
			string,
			EventIdError,
			EventIdRequirements
		>,
	) {}

	dispatch(
		input: DispatchInput<Command>,
	): Effect.Effect<
		CommandReceipt,
		DomainError | StorageError | EventIdError,
		EventIdRequirements
	> {
		return this.worker.run(input.streamId, this.run(input));
	}

	private readonly run = Effect.fn("AggregateDispatchEngine.run")(function* (
		this: AggregateDispatchEngine<
			State,
			Command,
			Event,
			DomainError,
			StorageError,
			EventIdError,
			EventIdRequirements
		>,
		input: DispatchInput<Command>,
	) {
		const existing = yield* this.storage.receipt(input.commandId);
		if (existing !== null) return existing;

		const stored = yield* this.storage.events(input.streamId);
		const state = this.aggregate.evolveAll(
			this.aggregate.initialState,
			stored.map((record) => record.event),
		);
		const decision = this.aggregate.decide(state, input.command);
		if (Result.isFailure(decision)) {
			return yield* Effect.fail(decision.failure);
		}

		const events = yield* Effect.forEach(decision.success, (event) =>
			this.makeEventId().pipe(Effect.map((eventId) => ({ eventId, event }))),
		);
		const append: AppendInput<Event> = {
			commandId: input.commandId,
			streamId: input.streamId,
			correlationId: input.correlationId ?? input.commandId,
			causationEventId: input.causationEventId ?? null,
			expectedVersion: this.aggregate.version(state),
			events,
		};
		return yield* this.storage.append(append);
	});
}
