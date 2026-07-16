import { Context, Effect, Layer, Schema } from "effect";
import { SqlClient } from "effect/unstable/sql";
import type { SqlError } from "effect/unstable/sql/SqlError";

import type {
	MessageReadRecord,
	SessionReadRecord,
} from "../projectors/read-model.js";
import type {
	MessagePage,
	MessagePageInput,
	SessionListInput,
	SessionTranscript,
} from "./session-queries.js";
import { SessionQueryNotFound } from "./session-queries.js";

export class SessionQueryDecodeError extends Schema.TaggedErrorClass<SessionQueryDecodeError>()(
	"SessionQueryDecodeError",
	{
		recordKind: Schema.Literals(["session", "message"]),
		reason: Schema.String,
	},
) {}

export type SqlSessionQueryError =
	| SqlError
	| SessionQueryNotFound
	| SessionQueryDecodeError;

interface SessionRow {
	readonly id: string;
	readonly chat_id: string;
	readonly project_id: string;
	readonly title: string;
	readonly status: Exclude<SessionReadRecord["status"], "deleted">;
	readonly provider_id: string;
	readonly model: string;
	readonly cursor: string | null;
	readonly provider_event_cursor?: string | null;
	readonly resume_strategy: string;
	readonly runtime_mode: string;
	readonly agents_json: string | null;
	readonly worktree_id: string | null;
	readonly forked_from_session_id: string | null;
	readonly forked_from_message_id: string | null;
	readonly permission_mode: string;
	readonly tool_search: number;
	readonly archived_at: string | null;
	readonly created_at: string;
	readonly updated_at: string;
}

interface MessageRow {
	readonly id: string;
	readonly session_id: string;
	readonly role: string;
	readonly kind: string;
	readonly content_json: string;
	readonly parent_item_id: string | null;
	readonly created_at: string;
	readonly sequence: number;
}

export type SqlSessionReadRecord = SessionReadRecord & {
	readonly providerEventCursor: string | null;
	readonly status: Exclude<SessionReadRecord["status"], "deleted">;
	readonly title: string;
	readonly providerId: string;
	readonly model: string;
	readonly resumeStrategy: string;
	readonly runtimeMode: string;
	readonly permissionMode: string;
};

const timestamp = (
	value: string,
	recordKind: "session" | "message",
): Effect.Effect<number, SessionQueryDecodeError> => {
	const parsed = Date.parse(value);
	return Number.isFinite(parsed)
		? Effect.succeed(parsed)
		: Effect.fail(
				new SessionQueryDecodeError({
					recordKind,
					reason: `invalid timestamp: ${value}`,
				}),
			);
};

const sessionRecord = Effect.fn("SqlSessionQueries.sessionRecord")(function* (
	row: SessionRow,
) {
	return {
		sessionId: row.id,
		chatId: row.chat_id,
		projectId: row.project_id,
		title: row.title,
		status: row.status,
		providerId: row.provider_id,
		model: row.model,
		cursor: row.cursor,
		providerEventCursor: row.provider_event_cursor ?? null,
		resumeStrategy: row.resume_strategy,
		runtimeMode: row.runtime_mode,
		agentsJson: row.agents_json,
		worktreeId: row.worktree_id,
		forkedFromSessionId: row.forked_from_session_id,
		forkedFromMessageId: row.forked_from_message_id,
		permissionMode: row.permission_mode,
		toolSearch: row.tool_search !== 0,
		archivedAt:
			row.archived_at === null
				? null
				: yield* timestamp(row.archived_at, "session"),
		deletedAt: null,
		lastMessageAt: null,
		createdAt: yield* timestamp(row.created_at, "session"),
		updatedAt: yield* timestamp(row.updated_at, "session"),
	} satisfies SqlSessionReadRecord;
});

const messageRecord = Effect.fn("SqlSessionQueries.messageRecord")(function* (
	row: MessageRow,
) {
	return {
		messageId: row.id,
		sessionId: row.session_id,
		turnId: null,
		role: row.role,
		kind: row.kind,
		contentJson: row.content_json,
		parentItemId: row.parent_item_id,
		createdAt: yield* timestamp(row.created_at, "message"),
		sequence: row.sequence,
	} satisfies MessageReadRecord;
});

export interface SqlSessionQueriesApi {
	readonly list: (
		input: SessionListInput,
	) => Effect.Effect<readonly SqlSessionReadRecord[], SqlSessionQueryError>;
	readonly get: (
		sessionId: string,
	) => Effect.Effect<SqlSessionReadRecord, SqlSessionQueryError>;
	readonly messages: (
		sessionId: string,
	) => Effect.Effect<readonly MessageReadRecord[], SqlSessionQueryError>;
	readonly messagePage: (
		input: MessagePageInput,
	) => Effect.Effect<MessagePage, SqlSessionQueryError>;
	readonly transcript: (
		sessionId: string,
	) => Effect.Effect<SessionTranscript, SqlSessionQueryError>;
}

export const makeSqlSessionQueries = (
	sql: SqlClient.SqlClient,
): SqlSessionQueriesApi => {
	const get = Effect.fn("SqlSessionQueries.get")(function* (sessionId: string) {
		const rows = yield* sql.unsafe<SessionRow>(
			"SELECT * FROM sessions WHERE id = ? LIMIT 1",
			[sessionId],
		);
		const row = rows[0];
		if (row === undefined)
			return yield* new SessionQueryNotFound({ sessionId });
		return yield* sessionRecord(row);
	});

	const messages = Effect.fn("SqlSessionQueries.messages")(function* (
		sessionId: string,
	) {
		yield* get(sessionId);
		const rows = yield* sql<MessageRow>`
			SELECT id, session_id, role, kind, content_json, parent_item_id,
				created_at, sequence
			FROM messages WHERE session_id = ${sessionId}
			ORDER BY sequence ASC
		`;
		return yield* Effect.forEach(rows, messageRecord);
	});

	const list = Effect.fn("SqlSessionQueries.list")(function* (
		input: SessionListInput,
	) {
		const archived = input.includeArchived === true;
		const rows = yield* sql.unsafe<SessionRow>(
			`SELECT * FROM sessions
			 WHERE project_id = ? AND (? = 1 OR archived_at IS NULL)
			 ORDER BY updated_at DESC, id ASC`,
			[input.projectId, archived ? 1 : 0],
		);
		return yield* Effect.forEach(rows, sessionRecord);
	});

	const messagePage = Effect.fn("SqlSessionQueries.messagePage")(function* (
		input: MessagePageInput,
	) {
		yield* get(input.sessionId);
		const after = input.afterSequence ?? 0;
		const rows = yield* sql<MessageRow>`
			SELECT id, session_id, role, kind, content_json, parent_item_id,
				created_at, sequence
			FROM messages
			WHERE session_id = ${input.sessionId} AND sequence > ${after}
			ORDER BY sequence ASC
			LIMIT ${input.limit + 1}
		`;
		const records = yield* Effect.forEach(rows, messageRecord);
		const items = records.slice(0, input.limit);
		return {
			items,
			nextSequence:
				records.length > items.length ? (items.at(-1)?.sequence ?? null) : null,
		};
	});

	const transcript = Effect.fn("SqlSessionQueries.transcript")(function* (
		sessionId: string,
	) {
		const session = yield* get(sessionId);
		return { session, messages: yield* messages(sessionId) };
	});

	return { list, get, messages, messagePage, transcript };
};

export class SqlSessionQueries extends Context.Service<
	SqlSessionQueries,
	SqlSessionQueriesApi
>()("zuse/domain/queries/SqlSessionQueries") {
	static readonly layer: Layer.Layer<
		SqlSessionQueries,
		never,
		SqlClient.SqlClient
	> = Layer.effect(
		SqlSessionQueries,
		Effect.map(SqlClient.SqlClient, makeSqlSessionQueries),
	);
}
