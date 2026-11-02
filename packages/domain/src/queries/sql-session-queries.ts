import {
	AgentTurnId,
	AttemptId,
	ProviderTurnReference,
	type SessionAttemptCursor,
	type SessionAttemptHistoryPage,
} from "@zuse/contracts";
import { Context, Effect, Layer, Schema } from "effect";
import { SqlClient } from "effect/unstable/sql";
import type { SqlError } from "effect/unstable/sql/SqlError";
import type { AttemptState } from "../core/state.js";
import type {
	MessageReadRecord,
	SessionProviderThreadRecord,
	SessionReadRecord,
} from "../projectors/read-model.js";
import { ACTIVE_SESSION_TURN_STATUSES } from "../projectors/sql-session-projector.js";
import type {
	MessagePage,
	MessagePageInput,
	SessionListInput,
	SessionTranscript,
} from "./session-queries.js";
import { SessionQueryNotFound } from "./session-queries.js";

import {
	MESSAGE_ROW_COLUMNS,
	type MessageRow,
	makeSqlMessageQueries,
	messageRecord,
	SessionQueryDecodeError,
} from "./sql-message-queries.js";

export { SessionQueryDecodeError } from "./sql-message-queries.js";

export type SqlSessionQueryError =
	| SqlError
	| SessionQueryNotFound
	| SessionQueryDecodeError;

export interface SessionRow {
	readonly parent_session_id?: string | null;
	readonly id: string;
	readonly chat_id: string;
	readonly project_id: string;
	readonly title: string;
	readonly title_provenance: "pending" | "automatic" | "manual";
	readonly status: Exclude<SessionReadRecord["status"], "deleted">;
	readonly provider_id: string;
	readonly model: string;
	readonly active_provider_thread_id: string | null;
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
	readonly pt_id: string | null;
	readonly pt_provider: string | null;
	readonly pt_native_thread_id: string | null;
	readonly pt_native_head_id: string | null;
	readonly pt_status: string | null;
	readonly pt_first_turn_ordinal: number | null;
	readonly pt_last_turn_ordinal: number | null;
	readonly pt_created_at: string | null;
	readonly pt_updated_at: string | null;
}

/** Omit delegation metadata only when reading retained snapshots predating that table. */
export const sessionWithProviderThreadSelect = (includeDelegations = true) => `
	SELECT s.*, ${includeDelegations ? "d.parent_session_id" : "NULL AS parent_session_id"},
		p.id AS pt_id, p.provider AS pt_provider,
		p.native_thread_id AS pt_native_thread_id,
		p.native_head_id AS pt_native_head_id, p.status AS pt_status,
		p.first_turn_ordinal AS pt_first_turn_ordinal,
		p.last_turn_ordinal AS pt_last_turn_ordinal,
		p.created_at AS pt_created_at, p.updated_at AS pt_updated_at
	FROM sessions s
	${includeDelegations ? "LEFT JOIN session_delegations d ON d.child_session_id = s.id" : ""}
	LEFT JOIN session_provider_threads p ON p.id = s.active_provider_thread_id`;

export const SESSION_WITH_PROVIDER_THREAD_SELECT =
	sessionWithProviderThreadSelect();

const providerThreadFromRow = (
	row: SessionRow,
): SessionProviderThreadRecord | null =>
	row.pt_id === null ||
	row.pt_provider === null ||
	row.pt_native_thread_id === null ||
	row.pt_status === null
		? null
		: {
				id: row.pt_id,
				provider: row.pt_provider,
				nativeThreadId: row.pt_native_thread_id,
				nativeHeadId: row.pt_native_head_id,
				status: row.pt_status as SessionProviderThreadRecord["status"],
				firstTurnOrdinal: row.pt_first_turn_ordinal,
				lastTurnOrdinal: row.pt_last_turn_ordinal,
				createdAt: Date.parse(row.pt_created_at ?? ""),
				updatedAt: Date.parse(row.pt_updated_at ?? ""),
			};

export type SqlSessionReadRecord = SessionReadRecord & {
	readonly parentSessionId?: string | null;
	readonly status: Exclude<SessionReadRecord["status"], "deleted">;
	readonly title: string;
	readonly titleProvenance: "pending" | "automatic" | "manual";
	readonly providerId: string;
	readonly model: string;
	readonly runtimeMode: string;
	readonly permissionMode: string;
};

const timestamp = (
	value: string,
	recordKind: "session" | "message" | "attempt",
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

export const decodeSessionRow = Effect.fn("SqlSessionQueries.decodeSessionRow")(
	function* (row: SessionRow) {
		return {
			sessionId: row.id,
			parentSessionId: row.parent_session_id ?? null,
			chatId: row.chat_id,
			projectId: row.project_id,
			title: row.title,
			titleProvenance: row.title_provenance,
			status: row.status,
			providerId: row.provider_id,
			model: row.model,
			activeProviderThread: providerThreadFromRow(row),
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
	},
);

export interface AttemptHistoryInput {
	readonly sessionId: string;
	readonly turnId: string;
	readonly afterOrdinal?: number;
	readonly limit?: number;
}
export interface AttemptHistoryPage {
	readonly items: readonly AttemptState[];
	readonly nextOrdinal: number | null;
}

export interface ChatSessionListInput {
	readonly chatId: string;
	readonly includeArchived?: boolean;
	readonly order?: "created" | "updated";
}

export interface SqlSessionQueriesApi
	extends ReturnType<typeof makeSqlMessageQueries> {
	readonly listByChat: (
		input: ChatSessionListInput,
	) => Effect.Effect<readonly SqlSessionReadRecord[], SqlSessionQueryError>;
	readonly activeTurnCount: Effect.Effect<number, SqlSessionQueryError>;
	readonly attemptProviderTurn: (
		sessionId: string,
		attemptId: string,
	) => Effect.Effect<ProviderTurnReference | null, SqlSessionQueryError>;
	readonly attemptHistory: (
		input: AttemptHistoryInput,
	) => Effect.Effect<AttemptHistoryPage, SqlSessionQueryError>;
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
	const messageQueries = makeSqlMessageQueries(sql);
	const get = Effect.fn("SqlSessionQueries.get")(function* (sessionId: string) {
		const rows = yield* sql.unsafe<SessionRow>(
			`${SESSION_WITH_PROVIDER_THREAD_SELECT} WHERE s.id = ? LIMIT 1`,
			[sessionId],
		);
		const row = rows[0];
		if (row === undefined)
			return yield* new SessionQueryNotFound({ sessionId });
		return yield* decodeSessionRow(row);
	});

	const attemptProviderTurn: SqlSessionQueriesApi["attemptProviderTurn"] = (
		sessionId,
		attemptId,
	) =>
		Effect.gen(function* () {
			yield* get(sessionId);
			const rows = yield* sql<{
				provider_turn_json: string | null;
			}>`SELECT provider_turn_json FROM session_attempts WHERE session_id = ${sessionId} AND id = ${attemptId} LIMIT 1`;
			const json = rows[0]?.provider_turn_json;
			if (json === undefined || json === null) return null;
			return yield* Schema.decodeUnknownEffect(
				Schema.fromJsonString(ProviderTurnReference),
			)(json).pipe(
				Effect.mapError(
					() =>
						new SessionQueryDecodeError({
							recordKind: "attempt",
							reason: "Invalid native execution reference",
						}),
				),
			);
		});

	const attemptHistory: SqlSessionQueriesApi["attemptHistory"] = (input) =>
		Effect.gen(function* () {
			yield* get(input.sessionId);
			const limit =
				input.limit !== undefined && Number.isSafeInteger(input.limit)
					? Math.max(1, Math.min(100, input.limit))
					: 50;
			const after =
				input.afterOrdinal !== undefined &&
				Number.isSafeInteger(input.afterOrdinal)
					? Math.max(0, input.afterOrdinal)
					: 0;
			const rows = yield* sql<{
				id: string;
				ordinal: number;
				reason: AttemptState["reason"];
				status: AttemptState["status"];
				started_at: string;
				completed_at: string | null;
			}>`SELECT id, ordinal, reason, status, started_at, completed_at FROM session_attempts
			WHERE session_id = ${input.sessionId} AND turn_id = ${input.turnId} AND ordinal > ${after}
			ORDER BY ordinal LIMIT ${limit + 1}`;
			const items = yield* Effect.forEach(rows.slice(0, limit), attemptRecord);
			return {
				items,
				nextOrdinal:
					rows.length > limit ? (items.at(-1)?.ordinal ?? null) : null,
			};
		});

	const messages = Effect.fn("SqlSessionQueries.messages")(function* (
		sessionId: string,
	) {
		yield* get(sessionId);
		return yield* messageQueries.messageList({ sessionId });
	});

	const list = Effect.fn("SqlSessionQueries.list")(function* (
		input: SessionListInput,
	) {
		const archived = input.includeArchived === true;
		const rows = yield* sql.unsafe<SessionRow>(
			`${SESSION_WITH_PROVIDER_THREAD_SELECT}
			 WHERE s.project_id = ? AND (? = 1 OR s.archived_at IS NULL)
			 ORDER BY s.updated_at DESC, s.id ASC`,
			[input.projectId, archived ? 1 : 0],
		);
		return yield* Effect.forEach(rows, decodeSessionRow);
	});

	const listByChat = Effect.fn("SqlSessionQueries.listByChat")(function* (
		input: ChatSessionListInput,
	) {
		const order =
			input.order === "created" ? "s.created_at ASC" : "s.updated_at DESC";
		const rows = yield* sql.unsafe<SessionRow>(
			`${SESSION_WITH_PROVIDER_THREAD_SELECT}
			 WHERE s.chat_id = ? AND (? = 1 OR s.archived_at IS NULL)
			 ORDER BY ${order}, s.id ASC`,
			[input.chatId, input.includeArchived === true ? 1 : 0],
		);
		return yield* Effect.forEach(rows, decodeSessionRow);
	});

	const messagePage = Effect.fn("SqlSessionQueries.messagePage")(function* (
		input: MessagePageInput,
	) {
		yield* get(input.sessionId);
		const before = input.beforeSequence ?? Number.MAX_SAFE_INTEGER;
		const rows = yield* sql<MessageRow>`
			SELECT ${sql.literal(MESSAGE_ROW_COLUMNS)}
			FROM messages
			WHERE session_id = ${input.sessionId} AND sequence < ${before}
			ORDER BY sequence DESC
			LIMIT ${input.limit + 1}
		`;
		const records = yield* Effect.forEach(rows, messageRecord);
		const items = records.slice(0, input.limit).reverse();
		return {
			items,
			olderSequence:
				records.length > input.limit ? (items[0]?.sequence ?? null) : null,
		};
	});

	const transcript = Effect.fn("SqlSessionQueries.transcript")(function* (
		sessionId: string,
	) {
		const session = yield* get(sessionId);
		return { session, messages: yield* messages(sessionId) };
	});

	return {
		...messageQueries,
		activeTurnCount: sql<{
			count: number;
		}>`SELECT COUNT(*) AS count FROM session_turns t JOIN sessions s ON s.id = t.session_id
			WHERE t.status IN ${sql.in([...ACTIVE_SESSION_TURN_STATUSES])} AND s.archived_at IS NULL`.pipe(
			Effect.map((rows) => rows[0]?.count ?? 0),
		),
		list,
		listByChat,
		get,
		messages,
		messagePage,
		transcript,
		attemptHistory,
		attemptProviderTurn,
	};
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

interface AttemptHistoryRow {
	readonly id: string;
	readonly ordinal: number;
	readonly reason: AttemptState["reason"];
	readonly status: AttemptState["status"];
	readonly started_at: string;
	readonly completed_at: string | null;
}
const attemptRecord = (row: AttemptHistoryRow) =>
	Effect.gen(function* () {
		return {
			id: row.id,
			ordinal: row.ordinal,
			reason: row.reason,
			status: row.status,
			startedAt: yield* timestamp(row.started_at, "attempt"),
			completedAt:
				row.completed_at === null
					? null
					: yield* timestamp(row.completed_at, "attempt"),
		};
	});

/** Descending keyset pagination keeps concurrent newer attempts out of older pages. */
export const readSessionAttemptHistory = (
	sql: SqlClient.SqlClient,
	sessionId: string,
	before?: SessionAttemptCursor,
): Effect.Effect<SessionAttemptHistoryPage, SqlSessionQueryError> =>
	sql.withTransaction(
		Effect.gen(function* () {
			yield* makeSqlSessionQueries(sql).get(sessionId);
			if (
				before !== undefined &&
				![before.turnOrdinal, before.attemptOrdinal].every(
					(value) => Number.isSafeInteger(value) && value > 0,
				)
			)
				return yield* new SessionQueryDecodeError({
					recordKind: "attempt",
					reason: "Invalid attempt history cursor",
				});
			const beforeTurn = before?.turnOrdinal ?? Number.MAX_SAFE_INTEGER;
			const beforeAttempt = before?.attemptOrdinal ?? Number.MAX_SAFE_INTEGER;
			const rows = yield* sql<
				AttemptHistoryRow & {
					turn_id: string;
					turn_ordinal: number;
					turn_status: string;
				}
			>`
		SELECT a.id,a.ordinal,a.reason,a.status,a.started_at,a.completed_at,a.turn_id,t.ordinal AS turn_ordinal,t.status AS turn_status
		FROM session_attempts a JOIN session_turns t ON t.session_id=a.session_id AND t.id=a.turn_id
		WHERE a.session_id=${sessionId} AND (t.ordinal < ${beforeTurn} OR (t.ordinal = ${beforeTurn} AND a.ordinal < ${beforeAttempt}))
		ORDER BY t.ordinal DESC,a.ordinal DESC LIMIT 51`;
			const items = yield* Effect.forEach(rows.slice(0, 50), (row) =>
				attemptRecord(row).pipe(
					Effect.map((attempt) => ({
						...attempt,
						id: AttemptId.make(attempt.id),
						turnId: AgentTurnId.make(row.turn_id),
						turnOrdinal: row.turn_ordinal,
						rolledBack: row.turn_status === "rolled_back",
					})),
				),
			);
			const last = items.at(-1);
			return {
				items,
				nextCursor:
					rows.length > 50 && last !== undefined
						? { turnOrdinal: last.turnOrdinal, attemptOrdinal: last.ordinal }
						: null,
			};
		}),
	);
