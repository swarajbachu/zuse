import { ComposerInput, type SessionId } from "@zuse/contracts";
import { composerInputStartsDirectTurn } from "@zuse/domain/conversation/startup-input";
import { Effect } from "effect";
import type { SqlClient } from "effect/unstable/sql";
import type {
	QueueServiceShape,
	QueueTransactionServiceShape,
} from "../services/conversation-services.ts";

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
	`.pipe(Effect.orDie);
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

/**
 * Finalize a held startup item even when the background creation worker has
 * not inserted it yet. The operation row is the durable proof that this queue
 * id is expected; unrelated not-found updates still remain authoritative.
 */
export const updateQueuedMessageWithStartupHandoff = Effect.fn(
	"ChatCreation.updateQueuedMessageWithStartupHandoff",
)(function* (
	queue: QueueServiceShape,
	queueTransaction: QueueTransactionServiceShape,
	sql: SqlClient.SqlClient,
	commandId: string,
	sessionId: SessionId,
	queueId: string,
	input: ComposerInput,
) {
	return yield* queue
		.updateQueuedMessage(commandId, sessionId, queueId, input)
		.pipe(
			Effect.catchTag("QueuedMessageNotFoundError", (notFound) =>
				Effect.gen(function* () {
					const operations = yield* sql<{
						readonly operation_id: string;
						readonly phase: string;
						readonly startup_input_json: string | null;
						readonly startup_ready: number;
						readonly status: string;
					}>`
						SELECT operation_id, phase, status,
						       startup_input_json, startup_ready
						FROM chat_creation_operations
						WHERE initial_session_id = ${sessionId}
						  AND startup_queue_id = ${queueId}
						LIMIT 1
					`.pipe(Effect.orDie);
					const operation = operations[0];
					const originalInput =
						operation?.startup_input_json === null ||
						operation?.startup_input_json === undefined
							? null
							: ComposerInput.make(JSON.parse(operation.startup_input_json));
					if (
						operation === undefined ||
						operation.status === "failed" ||
						operation.phase === "failed" ||
						operation.phase === "cancelled" ||
						(operation.startup_ready !== 0 &&
							originalInput !== null &&
							composerInputStartsDirectTurn(originalInput))
					) {
						return yield* notFound;
					}
					if (operation.status !== "succeeded") {
						yield* persistChatStartupIntent(queueTransaction, sql, {
							operationId: operation.operation_id,
							sessionId,
							input,
							queueId,
							ready: true,
						});
					}
					return yield* queue.updateQueuedMessage(
						commandId,
						sessionId,
						queueId,
						input,
					);
				}),
			),
		);
});
