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
		for (const event of events) {
			if (event.sequence <= cursor) continue;
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
	});
}

export class InMemoryReactorStorage<
	Event extends ReactorEvent,
> extends InMemoryCursorStorage<Event> {}
