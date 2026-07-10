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

export type ReactorDefinition<Event, Command> = {
	readonly name: string;
	readonly react: (
		event: Event,
	) =>
		| PromiseLike<readonly ReactorCommand<Command>[]>
		| readonly ReactorCommand<Command>[];
};

export type ReactorDispatch<Command> = (
	input: ReactorDispatchInput<Command>,
) => PromiseLike<unknown>;

export class ReactorRunner<Event extends ReactorEvent, Command> {
	private readonly cursorName: string;

	constructor(
		private readonly storage: CursorStorage<Event>,
		private readonly dispatch: ReactorDispatch<Command>,
		private readonly reactor: ReactorDefinition<Event, Command>,
	) {
		this.cursorName = `reactor:${reactor.name}`;
	}

	async catchUp(): Promise<number> {
		let cursor = await this.storage.cursor(this.cursorName);
		const events = await this.storage.eventsAfter(cursor);
		for (const event of events) {
			if (event.sequence <= cursor) continue;
			const commands = await this.reactor.react(event);
			for (const [index, command] of commands.entries()) {
				await this.dispatch({
					...command,
					commandId: `${this.cursorName}:${event.eventId}:${index}`,
					correlationId: event.correlationId,
					causationEventId: event.eventId,
				});
			}
			await this.storage.commitCursor(this.cursorName, event.sequence);
			cursor = event.sequence;
		}
		return cursor;
	}
}

export class InMemoryReactorStorage<
	Event extends ReactorEvent,
> extends InMemoryCursorStorage<Event> {}
