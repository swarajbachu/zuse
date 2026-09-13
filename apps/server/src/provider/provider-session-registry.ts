/**
 * Process-local ownership registry for provider handles.
 *
 * A generation is a lease: only the latest generation for a session may
 * publish a handle. Invalidation advances the generation even when no handle
 * has finished starting, so stop/switch commands defeat late startups.
 */
export interface ProviderSessionRegistry<SessionId, Entry> {
	readonly lookup: (sessionId: SessionId) => Entry | undefined;
	readonly currentGeneration: (sessionId: SessionId) => number | undefined;
	readonly isCurrent: (sessionId: SessionId, generation: number) => boolean;
	readonly begin: (sessionId: SessionId) => number;
	readonly publish: (
		sessionId: SessionId,
		generation: number,
		entry: Entry,
	) => boolean;
	readonly invalidate: (sessionId: SessionId) => Entry | undefined;
	readonly invalidateIfCurrent: (
		sessionId: SessionId,
		generation: number,
	) => Entry | undefined;
}

export const makeProviderSessionRegistry = <
	SessionId,
	Entry,
>(): ProviderSessionRegistry<SessionId, Entry> => {
	const sessions = new Map<SessionId, Entry>();
	const generations = new Map<SessionId, number>();
	const invalidate = (sessionId: SessionId): Entry | undefined => {
		const entry = sessions.get(sessionId);
		sessions.delete(sessionId);
		generations.set(sessionId, (generations.get(sessionId) ?? 0) + 1);
		return entry;
	};
	return {
		lookup: (sessionId) => sessions.get(sessionId),
		currentGeneration: (sessionId) => generations.get(sessionId),
		isCurrent: (sessionId, generation) =>
			generations.get(sessionId) === generation && sessions.has(sessionId),
		begin: (sessionId) => {
			const generation = (generations.get(sessionId) ?? 0) + 1;
			generations.set(sessionId, generation);
			return generation;
		},
		publish: (sessionId, generation, entry) => {
			if (generations.get(sessionId) !== generation) return false;
			sessions.set(sessionId, entry);
			return true;
		},
		invalidate,
		invalidateIfCurrent: (sessionId, generation) =>
			generations.get(sessionId) === generation
				? invalidate(sessionId)
				: undefined,
	};
};
