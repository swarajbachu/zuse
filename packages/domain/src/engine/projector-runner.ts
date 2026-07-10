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
	>
	extends InMemoryCursorStorage<Event>
	implements ProjectorStorage<Event>
{
	async applyAndCommit(
		projectorName: string,
		sequence: number,
		apply: () => PromiseLike<void> | void,
	): Promise<void> {
		await apply();
		await this.commitCursor(projectorName, sequence);
	}
}

import { InMemoryCursorStorage } from "./cursor-storage.js";
