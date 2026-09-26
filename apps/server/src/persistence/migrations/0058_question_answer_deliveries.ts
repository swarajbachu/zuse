import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql";

/**
 * Durable intent for answering or cancelling a provider-owned user question.
 *
 * The intent is committed before crossing the provider boundary. Only the
 * paired `user_question_answer` message is a public, replay-safe receipt;
 * ambiguous provider delivery must never become a durable success marker.
 */
export const Migration0058QuestionAnswerDeliveries = Effect.gen(function* () {
	const sql = yield* SqlClient.SqlClient;
	yield* sql`
		CREATE TABLE question_answer_deliveries (
			session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
			item_id TEXT NOT NULL,
			action TEXT NOT NULL CHECK (action IN ('answer', 'cancel')),
			answers_json TEXT,
			created_at INTEGER NOT NULL,
			updated_at INTEGER NOT NULL,
			CHECK (
				(action = 'answer' AND answers_json IS NOT NULL) OR
				(action = 'cancel' AND answers_json IS NULL)
			),
			PRIMARY KEY (session_id, item_id)
		)
	`;
});
