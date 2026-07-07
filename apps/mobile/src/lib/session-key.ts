import type { SessionId } from "@zuse/wire";

export const connectionSessionKey = (
  connKey: string,
  sessionId: SessionId | string,
): string => JSON.stringify([connKey, sessionId]);
