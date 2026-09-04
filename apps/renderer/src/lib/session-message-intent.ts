import type {
	ClientCommand,
	OutboxEntry,
} from "@zuse/client-runtime/client-persistence";
import type { SessionRef } from "@zuse/client-runtime/resource-ref";
import type {
	ResourceCursor,
	ResourceView,
} from "@zuse/client-runtime/resource-state";
import { decodeCloudMessageSendPayload } from "@zuse/cloud-commands";
import {
	type ComposerInput,
	isCloudCommandFailureState,
	Message,
	type MessageContent,
	type MessageId,
	type SessionId,
	type SessionTimelineProjection,
} from "@zuse/contracts";

const cursorChanged = (
	left: ResourceCursor | null,
	right: ResourceView<unknown>["cursor"],
): boolean =>
	right !== null &&
	(left === null ||
		left.epoch !== right.epoch ||
		left.version !== right.version);

/**
 * A send receipt proves runtime SQLite accepted the command, while this proof
 * closes the later UI handoff to the authoritative timeline. Optimistic user
 * messages retain the old cursor, so they cannot satisfy the fence themselves.
 */
export const sessionMessageCommandReflected = (
	command: ClientCommand,
	view: ResourceView<unknown>,
): boolean => {
	if (
		command.kind !== "messages.send" ||
		command.resourceReflection === undefined ||
		view.data === null ||
		!cursorChanged(command.resourceReflection.cursor, view.cursor)
	)
		return false;
	const payload = decodeCloudMessageSendPayload(command.payload);
	if (payload === null) return false;
	const projection = view.data as SessionTimelineProjection;
	const messageIndex = projection.messages.findIndex(
		(message) => message.id === payload.clientMessageId,
	);
	if (messageIndex < 0) return false;
	if (
		projection.currentTurn !== null ||
		projection.status === "booting" ||
		projection.status === "running" ||
		projection.status === "error" ||
		projection.status === "closed"
	)
		return true;
	return projection.messages
		.slice(messageIndex + 1)
		.some((message) => message.role !== "user");
};

export const optimisticSessionMessageContent = (
	input: string | ComposerInput,
	asGoal: boolean,
): MessageContent => {
	if (typeof input === "string") {
		return { _tag: "user", text: input, goal: asGoal };
	}
	const annotations = input.annotations ?? [];
	if (
		input.attachments.length === 0 &&
		input.fileRefs.length === 0 &&
		input.skillRefs.length === 0 &&
		annotations.length === 0
	) {
		return { _tag: "user", text: input.text, goal: asGoal };
	}
	return {
		_tag: "user_rich",
		text: input.text,
		attachments: input.attachments,
		fileRefs: input.fileRefs,
		skillRefs: input.skillRefs,
		annotations,
		goal: asGoal,
	};
};

export const makeOptimisticSessionMessage = (input: {
	readonly sessionId: SessionId;
	readonly messageId: MessageId;
	readonly content: string | ComposerInput;
	readonly asGoal: boolean;
	readonly createdAt: Date;
}): Message =>
	Message.make({
		id: input.messageId,
		sessionId: input.sessionId,
		role: "user",
		content: optimisticSessionMessageContent(input.content, input.asGoal),
		createdAt: input.createdAt,
	});

/**
 * Reconstructs a durable outbox-owned prompt, including the crash window after
 * the server accepted it but before the acceptance response reached the client.
 * The exact command/message identity remains stable across recovery; terminal
 * failures must not come back as optimistic prompts.
 */
export const durableOptimisticSessionMessage = (
	entry: OutboxEntry,
	ref: SessionRef,
): Message | null => {
	const { command, deliveryStatus } = entry;
	if (
		command.kind !== "messages.send" ||
		command.environmentId !== ref.environmentId ||
		command.resource?.kind !== "session-timeline" ||
		command.resource.ref.environmentId !== ref.environmentId ||
		!("sessionId" in command.resource.ref) ||
		command.resource.ref.sessionId !== ref.sessionId ||
		(deliveryStatus !== undefined &&
			isCloudCommandFailureState(deliveryStatus.state)) ||
		!Number.isFinite(command.createdAt)
	)
		return null;
	const payload = decodeCloudMessageSendPayload(command.payload);
	if (payload === null) return null;
	const messageId = payload.clientMessageId;
	if (
		payload.commandId !== command.commandId ||
		payload.sessionId !== ref.sessionId ||
		command.commandId !== `message-send:${messageId}`
	)
		return null;
	const content =
		typeof payload.text === "string" ? payload.text : (payload.input ?? null);
	if (content === null) return null;
	const createdAt = new Date(command.createdAt);
	if (Number.isNaN(createdAt.getTime())) return null;
	return makeOptimisticSessionMessage({
		sessionId: ref.sessionId,
		messageId: messageId as MessageId,
		content,
		asGoal: payload.asGoal === true,
		createdAt,
	});
};
