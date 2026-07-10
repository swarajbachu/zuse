export interface CursorStorage<Event> {
	cursor(consumerName: string): Promise<number>;
	eventsAfter(sequence: number): Promise<readonly Event[]>;
	commitCursor(consumerName: string, sequence: number): Promise<void>;
}

export class InMemoryCursorStorage<Event extends { readonly sequence: number }>
	implements CursorStorage<Event>
{
	private readonly cursors = new Map<string, number>();

	constructor(private readonly eventLog: readonly Event[]) {}

	cursor(consumerName: string): Promise<number> {
		return Promise.resolve(this.cursorValue(consumerName));
	}

	cursorValue(consumerName: string): number {
		return this.cursors.get(consumerName) ?? 0;
	}

	eventsAfter(sequence: number): Promise<readonly Event[]> {
		return Promise.resolve(
			this.eventLog.filter((event) => event.sequence > sequence),
		);
	}

	commitCursor(consumerName: string, sequence: number): Promise<void> {
		this.cursors.set(consumerName, sequence);
		return Promise.resolve();
	}
}
