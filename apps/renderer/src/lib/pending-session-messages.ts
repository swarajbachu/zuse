import {
	resourceRefKey,
	type SessionRef,
} from "@zuse/client-runtime/resource-ref";
import type { Message, MessageId } from "@zuse/contracts";
import { createAtomStore } from "../state/atom-store.ts";

// Preparation precedes durable mailbox submission. Keep that intent outside
// history snapshots so a checkpoint/reconnect cannot erase an unsent prompt.
const EMPTY_MESSAGES: readonly Message[] = [];
export const usePendingSessionMessages = createAtomStore<{
	byResource: Readonly<Record<string, readonly Message[]>>;
}>(() => ({ byResource: {} }));

export const pendingSessionMessages = (
	ref: SessionRef | null,
): readonly Message[] =>
	ref === null
		? EMPTY_MESSAGES
		: (usePendingSessionMessages.getState().byResource[resourceRefKey(ref)] ??
			EMPTY_MESSAGES);

export const putPendingSessionMessage = (
	ref: SessionRef,
	message: Message,
): void => {
	const key = resourceRefKey(ref);
	usePendingSessionMessages.setState((state) => ({
		byResource: {
			...state.byResource,
			[key]: [
				...(state.byResource[key] ?? []).filter(
					(item) => item.id !== message.id,
				),
				message,
			],
		},
	}));
};

export const clearPendingSessionMessage = (
	ref: SessionRef,
	id: MessageId,
): void => {
	const key = resourceRefKey(ref);
	usePendingSessionMessages.setState((state) => {
		const byResource = { ...state.byResource };
		const remaining = (byResource[key] ?? []).filter(
			(message) => message.id !== id,
		);
		if (remaining.length === 0) delete byResource[key];
		else byResource[key] = remaining;
		return { byResource };
	});
};

export const mergePendingSessionMessages = (
	messages: readonly Message[],
	pending: readonly Message[],
): readonly Message[] => {
	if (pending.length === 0) return messages;
	const ids = new Set(messages.map((message) => message.id));
	const missing = pending.filter((message) => !ids.has(message.id));
	return missing.length === 0 ? messages : [...messages, ...missing];
};
