export type ProjectorDefinition<Event> = {
	readonly name: string;
	readonly sequenceOf: (event: Event) => number;
	readonly apply: (event: Event) => PromiseLike<void> | void;
};

export interface ProjectorStorage<Event> {
	cursor(projectorName: string): Promise<number>;
	eventsAfter(sequence: number): Promise<readonly Event[]>;
	applyAndCommit(
		projectorName: string,
		sequence: number,
		apply: () => PromiseLike<void> | void,
	): Promise<void>;
}

export class ProjectorRunner<Event> {
	constructor(
		private readonly storage: ProjectorStorage<Event>,
		private readonly projector: ProjectorDefinition<Event>,
	) {}

	async catchUp(): Promise<number> {
		let cursor = await this.storage.cursor(this.projector.name);
		const events = await this.storage.eventsAfter(cursor);
		for (const event of events) {
			const sequence = this.projector.sequenceOf(event);
			if (sequence <= cursor) continue;
			await this.storage.applyAndCommit(this.projector.name, sequence, () =>
				this.projector.apply(event),
			);
			cursor = sequence;
		}
		return cursor;
	}
}

export class InMemoryProjectorStorage<
	Event extends { readonly sequence: number },
> implements ProjectorStorage<Event>
{
	private readonly cursors = new Map<string, number>();

	constructor(private readonly eventLog: readonly Event[]) {}

	cursor(projectorName: string): Promise<number> {
		return Promise.resolve(this.cursorValue(projectorName));
	}

	cursorValue(projectorName: string): number {
		return this.cursors.get(projectorName) ?? 0;
	}

	eventsAfter(sequence: number): Promise<readonly Event[]> {
		return Promise.resolve(
			this.eventLog.filter((event) => event.sequence > sequence),
		);
	}

	async applyAndCommit(
		projectorName: string,
		sequence: number,
		apply: () => PromiseLike<void> | void,
	): Promise<void> {
		await apply();
		this.cursors.set(projectorName, sequence);
	}
}
