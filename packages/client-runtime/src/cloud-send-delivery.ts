import type { PendingCommand } from "./resource-state.ts";

/**
 * A cloud message accepted by the mailbox but not yet claimed by a runtime.
 * Acceptance is not runtime ownership, including the first local dispatch
 * frame, so these sends must never read as a running turn.
 */
export const isWaitingCloudSend = (command: PendingCommand): boolean =>
	command.kind === "messages.send" &&
	(command.deliveryPhase === undefined ||
		command.deliveryPhase === "persisting" ||
		command.deliveryPhase === "reserved" ||
		command.deliveryPhase === "accepted" ||
		command.deliveryPhase === "waiting-for-runtime" ||
		command.deliveryPhase === "blocked");
