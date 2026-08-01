import { Effect } from "effect";
import { type CursorStorage, InMemoryCursorStorage } from "./cursor-storage.js";

export type ReactorEvent = {
	readonly eventId: string;
	readonly correlationId: string;
	readonly sequence: number;
};

export type ReactorCommand<Command> = {
	readonly streamId: string;
	readonly command: Command;
};

export type ReactorDispatchInput<Command> = ReactorCommand<Command> & {
	readonly commandId: string;
	readonly correlationId: string;
	readonly causationEventId: string;
};

export type ReactorDefinition<
	Event,
	Command,
	ReactorError = never,
	ReactorRequirements = never,
> = {
	readonly name: string;
	readonly react: (
		event: Event,
	) => Effect.Effect<
		readonly ReactorCommand<Command>[],
		ReactorError,
		ReactorRequirements
	>;
};

export type ReactorDispatch<
	Command,
	DispatchError = never,
	DispatchRequirements = never,
> = (
	input: ReactorDispatchInput<Command>,
) => Effect.Effect<unknown, DispatchError, DispatchRequirements>;

export type ReactorRunnerOptions = {
	/**
	 * Number of independent command streams that may be dispatched at once.
	 * Commands targeting one stream remain ordered across event boundaries. The
	 * cursor is committed only after the whole fetched batch succeeds, so replay
	 * stays durable on failure.
	 */
	readonly dispatchConcurrency?: number;
};

export class ReactorRunner<
	Event extends ReactorEvent,
	Command,
	StorageError = never,
	StorageRequirements = never,
	DispatchError = never,
	DispatchRequirements = never,
	ReactorError = never,
	ReactorRequirements = never,
> {
	private readonly cursorName: string;

	constructor(
		private readonly storage: CursorStorage<
			Event,
			StorageError,
			StorageRequirements
		>,
		private readonly dispatch: ReactorDispatch<
			Command,
			DispatchError,
			DispatchRequirements
		>,
		private readonly reactor: ReactorDefinition<
			Event,
			Command,
			ReactorError,
			ReactorRequirements
		>,
		private readonly options: ReactorRunnerOptions = {},
	) {
		this.cursorName = `reactor:${reactor.name}`;
	}

	readonly catchUp = Effect.fn("ReactorRunner.catchUp")(function* (
		this: ReactorRunner<
			Event,
			Command,
			StorageError,
			StorageRequirements,
			DispatchError,
			DispatchRequirements,
			ReactorError,
			ReactorRequirements
		>,
	): Effect.fn.Return<
		number,
		StorageError | DispatchError | ReactorError,
		StorageRequirements | DispatchRequirements | ReactorRequirements
	> {
		let cursor = yield* this.storage.cursor(this.cursorName);
		const events = yield* this.storage.eventsAfter(cursor);
		const pendingEvents = events.filter((event) => event.sequence > cursor);
		const dispatchConcurrency = Math.max(
			1,
			this.options.dispatchConcurrency ?? 1,
		);
		if (dispatchConcurrency === 1) {
			for (const event of pendingEvents) {
				const commands = yield* this.reactor.react(event);
				for (const [index, command] of commands.entries()) {
					yield* this.dispatch({
						...command,
						commandId: `${this.cursorName}:${event.eventId}:${index}`,
						correlationId: event.correlationId,
						causationEventId: event.eventId,
					});
				}
				yield* this.storage.commitCursor(this.cursorName, event.sequence);
				cursor = event.sequence;
			}
			return cursor;
		}

		const prepared = yield* Effect.forEach(pendingEvents, (event) =>
			this.reactor
				.react(event)
				.pipe(Effect.map((commands) => ({ commands, event }))),
		);
		const commandGroups = new Map<
			string,
			Array<{
				readonly command: ReactorCommand<Command>;
				readonly commandId: string;
				readonly correlationId: string;
				readonly causationEventId: string;
			}>
		>();
		for (const { commands, event } of prepared) {
			for (const [index, command] of commands.entries()) {
				const group = commandGroups.get(command.streamId) ?? [];
				group.push({
					command,
					commandId: `${this.cursorName}:${event.eventId}:${index}`,
					correlationId: event.correlationId,
					causationEventId: event.eventId,
				});
				commandGroups.set(command.streamId, group);
			}
		}
		yield* Effect.forEach(
			commandGroups.values(),
			(commands) =>
				Effect.forEach(commands, (entry) =>
					this.dispatch({
						...entry.command,
						commandId: entry.commandId,
						correlationId: entry.correlationId,
						causationEventId: entry.causationEventId,
					}),
				),
			{ concurrency: dispatchConcurrency, discard: true },
		);
		for (const { event } of prepared) {
			yield* this.storage.commitCursor(this.cursorName, event.sequence);
			cursor = event.sequence;
		}
		return cursor;
	});
}

export class InMemoryReactorStorage<
	Event extends ReactorEvent,
> extends InMemoryCursorStorage<Event> {}
