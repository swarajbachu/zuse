import type { PendingCommand } from "@zuse/client-runtime/resource-state";
import type { Message } from "@zuse/contracts";
import { ComposerInput } from "@zuse/contracts";
import type { ComposerContext } from "../store/composer-drafts.ts";
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

/** Acceptance is not runtime ownership, including the first local dispatch frame. */
export const isWaitingCloudSend = (command: PendingCommand): boolean =>
	command.kind === "messages.send" &&
	(command.deliveryPhase === undefined ||
		command.deliveryPhase === "persisting" ||
		command.deliveryPhase === "reserved" ||
		command.deliveryPhase === "accepted" ||
		command.deliveryPhase === "waiting-for-runtime" ||
		command.deliveryPhase === "blocked");

/** One presentation model for every mailbox state that is still waiting. */
export const waitingCloudMessagePresentation = (
	pendingCommands: readonly PendingCommand[],
): WaitingCloudMessagePresentation | null => {
	const command = pendingCommands.find(isWaitingCloudSend);
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
 * queues until its runtime stream is authoritative, and so does a local session
 * while the platform is offline: the agent provider needs the network, so the
 * message waits in the queue and drains on the online edge. Cloud sessions are
 * different: their control-plane mailbox is authoritative while compute sleeps,
 * so lack of a live stream must not divert a new turn back to live RPC.
 */
export const shouldQueueComposerMessage = (input: {
	readonly isCloudSession: boolean;
	readonly turnInFlight: boolean;
	readonly hasQueuedMessage: boolean;
	readonly runtimeStarting: boolean;
	readonly timelineLive: boolean;
	readonly platformOffline: boolean;
}): boolean =>
	input.turnInFlight ||
	input.hasQueuedMessage ||
	input.runtimeStarting ||
	(!input.isCloudSession && (!input.timelineLive || input.platformOffline));

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

/** Staged context joins the outgoing payload, leaving the editable draft untouched. */
export const withComposerContext = (
	input: ComposerInput,
	contexts: readonly ComposerContext[],
): ComposerInput =>
	contexts.length === 0
		? input
		: ComposerInput.make({
				...input,
				annotations: [
					...(input.annotations ?? []),
					...contexts.map((item) => ({
						_tag: "context" as const,
						id: item.id,
						label: item.label,
						comment: item.text,
					})),
				],
			});
/** Mailbox-owned prompts stay in the composer queue until claimed by the runtime. */
export const partitionCloudMessages = (
	messages: readonly Message[],
	pendingCommands: readonly PendingCommand[],
	preparingMessages: readonly Message[] = [],
): { transcript: readonly Message[]; waiting: readonly Message[] } => {
	const waitingIds = new Set(
		pendingCommands
			.filter(isWaitingCloudSend)
			.map((command) =>
				String(command.commandId).replace(/^message-send:/, ""),
			),
	);
	const dispatchedIds = new Set(
		pendingCommands.map((command) => String(command.commandId)),
	);
	for (const message of preparingMessages) {
		if (!dispatchedIds.has(`message-send:${message.id}`))
			waitingIds.add(message.id);
	}
	if (waitingIds.size === 0) return { transcript: messages, waiting: [] };
	return {
		transcript: messages.filter((message) => !waitingIds.has(message.id)),
		waiting: messages.filter((message) => waitingIds.has(message.id)),
	};
};

/** Landing validation must accept ownership before any draft state is consumed. */
export const handoffComposerDraft = (
	deliver: (accept: () => void) => void,
	commit: () => void,
): boolean => {
	let accepted = false;
	deliver(() => {
		if (accepted) return;
		accepted = true;
		commit();
	});
	return accepted;
};
