import type { PendingCommand } from "@zuse/client-runtime/resource-state";
import { cloudFailurePresentation } from "./cloud-failure-presentation.ts";

export type WaitingCloudMessagePresentation = Readonly<{
	commandId: PendingCommand["commandId"];
	label: string;
	cancellable: boolean;
}>;

/**
 * The current durable slice has no mailbox-backed queue mutation yet. Keep a
 * second cloud prompt in the composer until the first mailbox send reaches a
 * terminal receipt; otherwise it would silently fall back to fragile live RPC.
 */
export const cloudComposerSubmissionBlocked = (
	pendingCommands: readonly PendingCommand[],
): boolean =>
	pendingCommands.some((command) => command.kind === "messages.send");

const blockedCommandLabel = (command: PendingCommand): string => {
	const presentation = cloudFailurePresentation({
		category: command.category,
		blockedUntil: command.blockedUntil,
	});
	if (presentation !== null) return presentation.label;
	switch (command.blockedUntil) {
		case "workspace-unpaused":
			return "Workspace is paused";
		case "manual-retry":
			return "Action required";
		case "auth-restored":
		case "billing-restored":
		case "runtime-compatible":
			return "Action required";
	}
	return "Waiting for agent";
};

/** One presentation model for every mailbox state that is still waiting. */
export const waitingCloudMessagePresentation = (
	pendingCommands: readonly PendingCommand[],
): WaitingCloudMessagePresentation | null => {
	const command = pendingCommands.find(
		(candidate) =>
			candidate.kind === "messages.send" &&
			(candidate.deliveryPhase === "accepted" ||
				candidate.deliveryPhase === "waiting-for-runtime" ||
				candidate.deliveryPhase === "blocked"),
	);
	return command === undefined
		? null
		: {
				commandId: command.commandId,
				label:
					command.deliveryPhase === "blocked"
						? blockedCommandLabel(command)
						: "Waiting for agent",
				cancellable: command.cancellable === true,
			};
};

/**
 * A live turn still owns queue semantics. A disconnected local/SSH session also
 * queues until its runtime stream is authoritative. Cloud sessions are
 * different: their control-plane mailbox is authoritative while compute sleeps,
 * so lack of a live stream must not divert a new turn back to live RPC.
 */
export const shouldQueueComposerMessage = (input: {
	readonly isCloudSession: boolean;
	readonly turnInFlight: boolean;
	readonly hasQueuedMessage: boolean;
	readonly runtimeStarting: boolean;
	readonly timelineLive: boolean;
}): boolean =>
	input.turnInFlight ||
	input.hasQueuedMessage ||
	input.runtimeStarting ||
	(!input.isCloudSession && !input.timelineLive);

/** Keep the recoverable draft intact until the mailbox (or live runtime) acks. */
export const commitAcceptedComposerDelivery = async (
	delivery: Promise<boolean>,
	commit: () => void,
): Promise<boolean> => {
	const accepted = await delivery;
	if (!accepted) return false;
	commit();
	return true;
};
