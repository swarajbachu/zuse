import type { SessionId } from "@zuse/contracts";
import { createAtomStore } from "../state/atom-store.ts";

type QueueHydrationState = {
	readonly hydratedBySession: Readonly<Record<string, boolean>>;
};

export const useQueueHydrationStore = createAtomStore<QueueHydrationState>(
	() => ({ hydratedBySession: {} }),
);

export const markQueueHydrated = (sessionId: SessionId): void => {
	useQueueHydrationStore.setState((state) => {
		if (state.hydratedBySession[sessionId] === true) return state;
		return {
			hydratedBySession: {
				...state.hydratedBySession,
				[sessionId]: true,
			},
		};
	});
};

const acknowledgementListeners = new Set<(sessionId: SessionId) => void>();

export const subscribeSessionAcknowledged = (
	listener: (sessionId: SessionId) => void,
): (() => void) => {
	acknowledgementListeners.add(listener);
	return () => acknowledgementListeners.delete(listener);
};

export const notifySessionAcknowledged = (sessionId: SessionId): void => {
	for (const listener of acknowledgementListeners) listener(sessionId);
};
