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

	catchUp(): Effect.Effect<
		number,
		StorageError | ProjectorError,
		StorageRequirements | ProjectorRequirements
	> {
		const self = this;
		return Effect.gen(function* () {
			let cursor = yield* self.storage.cursor(self.projector.name);
			const events = yield* self.storage.eventsAfter(cursor);
			for (const event of events) {
				const sequence = self.projector.sequenceOf(event);
				if (sequence <= cursor) continue;
				yield* self.storage.applyAndCommit(
					self.projector.name,
					sequence,
					self.projector.apply(event),
				);
				cursor = sequence;
			}
			return cursor;
		});
	}
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
		const self = this;
		return Effect.gen(function* () {
			yield* apply;
			yield* self.commitCursor(projectorName, sequence);
		});
	}
}
