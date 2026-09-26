import type { AgentItemId, SessionId } from "@zuse/contracts";
import { Effect } from "effect";
import type { SqlClient } from "effect/unstable/sql";
import type { ProviderServiceShape } from "../../provider/services/provider-service.ts";
import {
	parseQuestionAnswerDeliveryPayload,
	type QuestionAnswerDeliveryPayload,
} from "./question-delivery.ts";

export type DurableQuestionResolution =
	| {
			readonly _tag: "answer";
			readonly delivery: QuestionAnswerDeliveryPayload;
	  }
	| { readonly _tag: "cancel" };

export type DurableQuestionResolutionLookup =
	| DurableQuestionResolution
	| { readonly _tag: "none" }
	| { readonly _tag: "invalid" };

/**
 * Read the one authoritative durable resolution for a provider-owned question.
 * Invalid/colliding receipts are kept distinct from absence so callers never
 * detach a live callback based on ambiguous persisted state.
 */
export const lookupDurableQuestionResolution = (
	sql: SqlClient.SqlClient,
	sessionId: SessionId,
	itemId: AgentItemId,
): Effect.Effect<DurableQuestionResolutionLookup> =>
	Effect.gen(function* () {
		const answerRows = yield* sql<{ readonly answers_json: string | null }>`
			SELECT json_extract(content_json, '$.answers') AS answers_json
			FROM messages
			WHERE session_id = ${sessionId}
			  AND kind = 'user_question_answer'
			  AND json_valid(content_json)
			  AND json_extract(content_json, '$.itemId') = ${itemId}
			LIMIT 2
		`.pipe(Effect.orDie);
		const cancellationRows = yield* sql<{ readonly found: number }>`
			SELECT 1 AS found
			FROM events
			WHERE stream_kind = 'session'
			  AND stream_id = ${sessionId}
			  AND type = 'QuestionResolved'
			  AND json_valid(payload_json)
			  AND json_extract(payload_json, '$.itemId') = ${itemId}
			LIMIT 2
		`.pipe(Effect.orDie);

		if (answerRows.length + cancellationRows.length === 0) {
			return { _tag: "none" } as const;
		}
		if (answerRows.length === 0 && cancellationRows.length === 1) {
			return { _tag: "cancel" } as const;
		}
		if (answerRows.length !== 1 || cancellationRows.length !== 0) {
			return { _tag: "invalid" } as const;
		}
		const answersJson = answerRows[0]?.answers_json;
		if (answersJson === null || answersJson === undefined) {
			return { _tag: "invalid" } as const;
		}
		const delivery = parseQuestionAnswerDeliveryPayload(answersJson);
		return delivery === null
			? ({ _tag: "invalid" } as const)
			: ({ _tag: "answer", delivery } as const);
	});

/**
 * Settle a durable receipt against any exact live callback before releasing
 * process-local actionability. With no live callback, the receipt itself is a
 * sufficient acknowledgement and stale outbox state can be removed.
 */
export const settleDurableQuestionResolution = (
	sql: SqlClient.SqlClient,
	provider: ProviderServiceShape,
	sessionId: SessionId,
	itemId: AgentItemId,
	resolution: DurableQuestionResolution,
): Effect.Effect<void, import("@zuse/contracts").AgentSessionNotFoundError> =>
	Effect.gen(function* () {
		if (yield* provider.hasQuestionAttachment(sessionId, itemId)) {
			if (resolution._tag === "answer") {
				yield* provider.answerQuestion(
					sessionId,
					itemId,
					resolution.delivery.answers,
				);
			} else {
				yield* provider.cancelQuestion(sessionId, itemId);
			}
		}
		yield* sql`
			DELETE FROM question_answer_deliveries
			WHERE session_id = ${sessionId} AND item_id = ${itemId}
		`.pipe(Effect.orDie);
		yield* provider.acknowledgeQuestionResolution(sessionId, itemId);
	});
