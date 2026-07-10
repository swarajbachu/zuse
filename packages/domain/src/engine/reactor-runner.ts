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

	catchUp(): Effect.Effect<
		number,
		StorageError | DispatchError | ReactorError,
		StorageRequirements | DispatchRequirements | ReactorRequirements
	> {
		const self = this;
		return Effect.gen(function* () {
			let cursor = yield* self.storage.cursor(self.cursorName);
			const events = yield* self.storage.eventsAfter(cursor);
			for (const event of events) {
				if (event.sequence <= cursor) continue;
				const commands = yield* self.reactor.react(event);
				for (const [index, command] of commands.entries()) {
					yield* self.dispatch({
						...command,
						commandId: `${self.cursorName}:${event.eventId}:${index}`,
						correlationId: event.correlationId,
						causationEventId: event.eventId,
					});
				}
				yield* self.storage.commitCursor(self.cursorName, event.sequence);
				cursor = event.sequence;
			}
			return cursor;
		});
	}
}

export class InMemoryReactorStorage<
	Event extends ReactorEvent,
> extends InMemoryCursorStorage<Event> {}
