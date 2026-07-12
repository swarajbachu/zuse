import type { SessionId } from "@zuse/contracts";

export const connectionSessionKey = (
  connKey: string,
  sessionId: SessionId | string,
): string => JSON.stringify([connKey, sessionId]);
