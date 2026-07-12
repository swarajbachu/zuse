import { Effect } from "effect";

export interface CursorStorage<Event, Error = never, Requirements = never> {
	cursor(consumerName: string): Effect.Effect<number, Error, Requirements>;
	eventsAfter(
		sequence: number,
	): Effect.Effect<readonly Event[], Error, Requirements>;
	commitCursor(
		consumerName: string,
		sequence: number,
	): Effect.Effect<void, Error, Requirements>;
}

export class InMemoryCursorStorage<Event extends { readonly sequence: number }>
	implements CursorStorage<Event>
{
	private readonly cursors = new Map<string, number>();

	constructor(private readonly eventLog: readonly Event[]) {}

	cursor(consumerName: string): Effect.Effect<number> {
		return Effect.sync(() => this.cursorValue(consumerName));
	}

	cursorValue(consumerName: string): number {
		return this.cursors.get(consumerName) ?? 0;
	}

	eventsAfter(sequence: number): Effect.Effect<readonly Event[]> {
		return Effect.sync(() =>
			this.eventLog.filter((event) => event.sequence > sequence),
		);
	}

	commitCursor(consumerName: string, sequence: number): Effect.Effect<void> {
		return Effect.sync(() => {
			this.cursors.set(consumerName, sequence);
		});
	}
}
