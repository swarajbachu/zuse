/** Deterministic turn id used on either side of a mixed-version rollout. */
export const cloudRuntimeCommandTurnId = (messageId: string): string =>
	`turn_${messageId}`;
