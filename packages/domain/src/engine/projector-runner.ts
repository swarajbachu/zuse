import { Effect } from "effect";
import { type CursorStorage, InMemoryCursorStorage } from "./cursor-storage.js";

export type ProjectorDefinition<
	Event,
	ProjectorError = never,
	ProjectorRequirements = never,
> = {
	readonly name: string;
	readonly sequenceOf: (event: Event) => number;
	readonly apply: (
		event: Event,
	) => Effect.Effect<void, ProjectorError, ProjectorRequirements>;
};

export interface ProjectorStorage<
	Event,
	StorageError = never,
	Requirements = never,
> extends CursorStorage<Event, StorageError, Requirements> {
	applyAndCommit<ApplyError, ApplyRequirements>(
		projectorName: string,
		sequence: number,
		apply: Effect.Effect<void, ApplyError, ApplyRequirements>,
	): Effect.Effect<
		void,
		StorageError | ApplyError,
		Requirements | ApplyRequirements
	>;
}

export class ProjectorRunner<
	Event,
	StorageError = never,
	StorageRequirements = never,
	ProjectorError = never,
	ProjectorRequirements = never,
> {
	constructor(
		private readonly storage: ProjectorStorage<
			Event,
			StorageError,
			StorageRequirements
		>,
		private readonly projector: ProjectorDefinition<
			Event,
			ProjectorError,
			ProjectorRequirements
		>,
	) {}

	readonly catchUp = Effect.fn("ProjectorRunner.catchUp")(function* (
		this: ProjectorRunner<
			Event,
			StorageError,
			StorageRequirements,
			ProjectorError,
			ProjectorRequirements
		>,
	): Effect.fn.Return<
		number,
		StorageError | ProjectorError,
		StorageRequirements | ProjectorRequirements
	> {
		let cursor = yield* this.storage.cursor(this.projector.name);
		const events = yield* this.storage.eventsAfter(cursor);
		for (const event of events) {
			const sequence = this.projector.sequenceOf(event);
			if (sequence <= cursor) continue;
			yield* this.storage.applyAndCommit(
				this.projector.name,
				sequence,
				this.projector.apply(event),
			);
			cursor = sequence;
		}
		return cursor;
	});
}

export class InMemoryProjectorStorage<
		Event extends { readonly sequence: number },
	>
	extends InMemoryCursorStorage<Event>
	implements ProjectorStorage<Event>
{
	applyAndCommit<ApplyError, ApplyRequirements>(
		projectorName: string,
		sequence: number,
		apply: Effect.Effect<void, ApplyError, ApplyRequirements>,
	): Effect.Effect<void, ApplyError, ApplyRequirements> {
		return Effect.flatMap(apply, () =>
			this.commitCursor(projectorName, sequence),
		);
	}
}
