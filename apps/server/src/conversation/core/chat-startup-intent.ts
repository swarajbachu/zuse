import { ComposerInput, type SessionId } from "@zuse/contracts";
import { Effect } from "effect";
import type { SqlClient } from "effect/unstable/sql";
import type { QueueTransactionServiceShape } from "../services/conversation-services.ts";

export interface ChatStartupIntent {
	readonly operationId: string;
	readonly sessionId: SessionId;
	readonly input: ComposerInput;
	readonly queueId: string;
	readonly ready: boolean;
}

const hasUnpreparedReferences = (input: ComposerInput): boolean =>
	input.attachments.some((attachment) =>
		attachment.id.startsWith("pending-"),
	) ||
	input.fileRefs.some((ref) =>
		ref.relPath.startsWith(".context/files/paste-pending-"),
	);

export const chatStartupCommandId = (operationId: string): string =>
	`chat-create:${operationId}:startup`;

export const decodeChatStartupIntent = (input: {
	readonly operationId?: string;
	readonly initialSessionId?: SessionId;
	readonly startupInput?: ComposerInput;
	readonly startupQueueId?: string;
	readonly startupReady?: boolean;
}): ChatStartupIntent | null => {
	if (
		input.operationId === undefined ||
		input.initialSessionId === undefined ||
		input.startupInput === undefined ||
		input.startupQueueId === undefined
	) {
		return null;
	}
	return {
		operationId: input.operationId,
		sessionId: input.initialSessionId,
		input: ComposerInput.make(input.startupInput),
		queueId: input.startupQueueId,
		ready: input.startupReady ?? true,
	};
};

export const persistChatStartupIntent = Effect.fn(
	"ChatCreation.persistStartupIntent",
)(function* (
	queueTransaction: QueueTransactionServiceShape,
	sql: SqlClient.SqlClient,
	intent: ChatStartupIntent,
) {
	const operations = yield* sql<{ readonly status: string }>`
		SELECT status
		FROM chat_creation_operations
		WHERE operation_id = ${intent.operationId}
		LIMIT 1
	`;
	if (operations[0]?.status === "succeeded") return false;

	// The internal queue transaction boundary owns the SessionDomain append and
	// projector transaction. Advancing the creation receipt inside its callback
	// commits queue record, command receipt, and operation receipt together.
	yield* queueTransaction.addQueuedMessageTransactionally(
		chatStartupCommandId(intent.operationId),
		intent.sessionId,
		intent.input,
		intent.queueId,
		intent.ready && !hasUnpreparedReferences(intent.input),
		() =>
			sql`
				UPDATE chat_creation_operations
				SET status = 'succeeded', error = NULL,
				    updated_at = ${new Date().toISOString()}
				WHERE operation_id = ${intent.operationId}
			`.pipe(Effect.asVoid, Effect.orDie),
	);
	return true;
});
