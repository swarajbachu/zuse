import type { Message } from "@zuse/contracts";

const EMPTY_SESSION_MESSAGES: readonly Message[] = [];

/** Stable Zustand snapshot for sessions that have not loaded messages yet. */
export const selectSessionMessages = (
	messagesBySession: Readonly<Record<string, readonly Message[]>>,
	key: string,
): readonly Message[] => messagesBySession[key] ?? EMPTY_SESSION_MESSAGES;
