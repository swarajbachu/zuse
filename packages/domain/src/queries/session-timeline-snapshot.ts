import {
	AgentTurnId,
	ComposerInput,
	DEFAULT_PERMISSION_MODE,
	DEFAULT_RUNTIME_MODE,
	MAX_SESSION_QUEUE_ITEMS,
	MAX_SESSION_QUEUE_TOTAL_BYTES,
	Message,
	MessageContent,
	MessageId,
	MessageRole,
	PermissionRequest,
	QueuedMessage,
	QueueState,
	type SessionId,
	type SessionInteraction,
	SessionTimelineProjection,
	SessionTimelineTurnPhase,
} from "@zuse/contracts";
import { Effect, Result, Schema } from "effect";
import type { SqlClient } from "effect/unstable/sql";

import type { SqlSessionQueryError } from "./sql-session-queries.js";
import { makeSqlSessionQueries } from "./sql-session-queries.js";

const LATEST_TIMELINE_MESSAGE_LIMIT = 100;
/** Leaves headroom for the RPC frame, cursor, and codec overhead under 1 MiB. */
const MAX_TIMELINE_SNAPSHOT_PROJECTION_BYTES = 900 * 1024;

interface TimelineHeadRow {
	readonly status: "booting" | "idle" | "running" | "closed" | "error";
	readonly runtime_mode: string;
	readonly permission_mode: string;
	readonly queue_paused: number;
	readonly current_turn_id: string | null;
	readonly current_turn_phase: string | null;
}

interface QueueRow {
	readonly id: string;
	readonly input_json: string;
	readonly queue_order: number;
	readonly created_at: string;
	readonly updated_at: string;
	readonly ready: number;
}

interface PendingQuestionRow {
	readonly content_json: string;
	readonly created_at: string;
}

interface PendingPermissionRow {
	readonly request_json: string;
}

export type SessionTimelineSnapshot = {
	readonly projection: SessionTimelineProjection;
	readonly olderMessageSequence: number | null;
	readonly totalMessageCount: number;
};

export type SessionTimelineMessagePage = {
	readonly items: ReadonlyArray<{
		readonly message: Message;
		readonly sequence: number;
	}>;
	readonly olderMessageSequence: number | null;
};

const decodeContent = Schema.decodeUnknownResult(
	Schema.fromJsonString(MessageContent),
);
const decodeRole = Schema.decodeUnknownResult(MessageRole);
const decodeDate = Schema.decodeUnknownResult(Schema.DateFromString);
const decodeComposer = Schema.decodeUnknownResult(
	Schema.fromJsonString(ComposerInput),
);
const decodePermissionRequest = Schema.decodeUnknownResult(
	Schema.fromJsonString(PermissionRequest),
);

const MAX_PENDING_SESSION_INTERACTIONS = 100;

const readPendingInteractions = Effect.fn("readPendingInteractions")(function* (
	sql: SqlClient.SqlClient,
	sessionId: SessionId,
) {
	const questionRows = yield* sql<PendingQuestionRow>`
			SELECT question.content_json, question.created_at
			FROM messages AS question
			WHERE question.session_id = ${sessionId}
				AND question.kind = 'user_question'
				AND json_valid(question.content_json)
				AND NOT EXISTS (
					SELECT 1 FROM messages AS answer
					WHERE answer.session_id = question.session_id
						AND answer.kind = 'user_question_answer'
						AND json_valid(answer.content_json)
						AND json_extract(answer.content_json, '$.itemId') =
							json_extract(question.content_json, '$.itemId')
				)
				AND NOT EXISTS (
					SELECT 1 FROM events AS resolution
					WHERE resolution.stream_kind = 'session'
						AND resolution.stream_id = question.session_id
						AND resolution.type = 'QuestionResolved'
						AND json_valid(resolution.payload_json)
						AND json_extract(resolution.payload_json, '$.itemId') =
							json_extract(question.content_json, '$.itemId')
				)
			ORDER BY question.sequence ASC
			LIMIT ${MAX_PENDING_SESSION_INTERACTIONS + 1}
		`;
	const permissionRows = yield* sql<PendingPermissionRow>`
			SELECT json_extract(requested.payload_json, '$.payloadJson') AS request_json
			FROM events AS requested
			WHERE requested.stream_kind = 'session'
				AND requested.stream_id = ${sessionId}
				AND requested.type = 'PermissionRequested'
				AND json_valid(requested.payload_json)
				AND NOT EXISTS (
					SELECT 1 FROM events AS resolved
					WHERE resolved.stream_kind = 'session'
						AND resolved.stream_id = requested.stream_id
						AND resolved.type = 'PermissionResolved'
						AND json_valid(resolved.payload_json)
						AND json_extract(resolved.payload_json, '$.requestId') =
							json_extract(requested.payload_json, '$.requestId')
				)
			ORDER BY requested.stream_version ASC
			LIMIT ${MAX_PENDING_SESSION_INTERACTIONS + 1}
		`;
	if (
		questionRows.length + permissionRows.length >
		MAX_PENDING_SESSION_INTERACTIONS
	) {
		return yield* Effect.die(
			new Error(
				`Session ${sessionId} exceeds the bounded pending interaction limit; repair is required`,
			),
		);
	}
	const interactions: SessionInteraction[] = [];
	for (const row of questionRows) {
		const content = decodeContent(row.content_json);
		const requestedAt = decodeDate(row.created_at);
		if (
			Result.isFailure(content) ||
			content.success._tag !== "user_question" ||
			Result.isFailure(requestedAt)
		) {
			continue;
		}
		interactions.push({
			_tag: "Question",
			id: content.success.itemId,
			questions: content.success.questions,
			requestedAt: requestedAt.success,
		});
	}
	for (const row of permissionRows) {
		const request = decodePermissionRequest(row.request_json);
		if (Result.isFailure(request)) continue;
		interactions.push({
			_tag: "Permission",
			id: request.success.id,
			request: request.success,
		});
	}
	interactions.sort((left, right) => {
		const leftAt =
			left._tag === "Question"
				? left.requestedAt.getTime()
				: left.request.requestedAt.getTime();
		const rightAt =
			right._tag === "Question"
				? right.requestedAt.getTime()
				: right.request.requestedAt.getTime();
		return leftAt - rightAt || left.id.localeCompare(right.id);
	});
	return interactions;
});

export const readSessionTimelineMessagePage = Effect.fn(
	"readSessionTimelineMessagePage",
)(function* (
	sql: SqlClient.SqlClient,
	sessionId: SessionId,
	beforeSequence?: number,
	limit = LATEST_TIMELINE_MESSAGE_LIMIT,
): Effect.fn.Return<SessionTimelineMessagePage, SqlSessionQueryError> {
	const page = yield* makeSqlSessionQueries(sql).messagePage({
		sessionId,
		beforeSequence,
		limit,
	});
	const items: Array<{
		readonly message: Message;
		readonly sequence: number;
	}> = [];
	for (const record of page.items) {
		const content = decodeContent(record.contentJson);
		const role = decodeRole(record.role);
		if (Result.isFailure(content) || Result.isFailure(role)) continue;
		items.push({
			message: Message.make({
				id: MessageId.make(record.messageId),
				sessionId,
				role: role.success,
				content: content.success,
				createdAt: new Date(record.createdAt),
			}),
			sequence: record.sequence,
		});
	}
	return { items, olderMessageSequence: page.olderSequence };
});

/** Read a bounded, fully materialized timeline without folding event history. */
export const readSessionTimelineSnapshot = Effect.fn(
	"readSessionTimelineSnapshot",
)(function* (
	sql: SqlClient.SqlClient,
	sessionId: SessionId,
): Effect.fn.Return<SessionTimelineSnapshot, SqlSessionQueryError> {
	const queries = makeSqlSessionQueries(sql);
	const headRows = yield* sql<TimelineHeadRow>`
		SELECT status, runtime_mode, permission_mode, queue_paused,
			current_turn_id, current_turn_phase
		FROM sessions WHERE id = ${sessionId} LIMIT 1
	`;
	const head = headRows[0];
	if (head === undefined) {
		// Reuse the query service's typed not-found boundary.
		yield* queries.get(sessionId);
		return yield* Effect.die("Session query existed without a timeline head");
	}
	const messagePage = yield* readSessionTimelineMessagePage(sql, sessionId);
	const messageCountRows = yield* sql<{ readonly count: number }>`
		SELECT COUNT(*) AS count FROM messages WHERE session_id = ${sessionId}
	`;
	const totalMessageCount = messageCountRows[0]?.count ?? 0;
	const messages = [...messagePage.items];
	const queueRows = yield* sql<QueueRow>`
		SELECT id, input_json, queue_order, created_at, updated_at, ready
		FROM queued_messages WHERE session_id = ${sessionId}
		ORDER BY queue_order ASC, id ASC
		LIMIT ${MAX_SESSION_QUEUE_ITEMS + 1}
	`;
	if (queueRows.length > MAX_SESSION_QUEUE_ITEMS) {
		return yield* Effect.die(
			new Error(
				`Session ${sessionId} exceeds the bounded queue item limit; repair is required`,
			),
		);
	}
	const queueItems: QueuedMessage[] = [];
	for (const row of queueRows) {
		const input = decodeComposer(row.input_json);
		if (Result.isFailure(input)) continue;
		queueItems.push(
			QueuedMessage.make({
				id: row.id,
				sessionId,
				input: input.success,
				position: row.queue_order,
				createdAt: new Date(row.created_at),
				updatedAt: new Date(row.updated_at),
				ready: row.ready !== 0,
			}),
		);
	}
	if (
		new TextEncoder().encode(
			JSON.stringify(QueueState.make({ items: queueItems, paused: false })),
		).byteLength > MAX_SESSION_QUEUE_TOTAL_BYTES
	) {
		return yield* Effect.die(
			new Error(
				`Session ${sessionId} exceeds the bounded queue byte limit; repair is required`,
			),
		);
	}
	const phase = Schema.decodeUnknownResult(SessionTimelineTurnPhase)(
		head.current_turn_phase,
	);
	const currentTurn =
		head.current_turn_id === null || Result.isFailure(phase)
			? null
			: {
					turnId: AgentTurnId.make(head.current_turn_id),
					phase: phase.success,
				};
	const runtimeMode = Schema.decodeUnknownResult(
		Schema.Literals([
			"approval-required",
			"auto-accept-edits",
			"auto-accept-edits-and-bash",
			"full-access",
		]),
	)(head.runtime_mode);
	const permissionMode = Schema.decodeUnknownResult(
		Schema.Literals(["default", "plan", "acceptEdits"]),
	)(head.permission_mode);
	const interactions = yield* readPendingInteractions(sql, sessionId);
	const makeProjection = () =>
		SessionTimelineProjection.make({
			messages: messages.map(({ message }) => message),
			olderMessageSequence: null,
			status: head.status,
			currentTurn,
			queue: QueueState.make({
				items: queueItems,
				paused: head.queue_paused !== 0,
			}),
			permissionMode: Result.isSuccess(permissionMode)
				? permissionMode.success
				: DEFAULT_PERMISSION_MODE,
			runtimeMode: Result.isSuccess(runtimeMode)
				? runtimeMode.success
				: DEFAULT_RUNTIME_MODE,
			interactions,
		});
	let projection = makeProjection();
	let omittedForBudget = false;
	let budgetPageCursor = messagePage.olderMessageSequence;
	const projectionBytes = () =>
		new TextEncoder().encode(JSON.stringify(projection)).byteLength;
	while (
		messages.length > 0 &&
		projectionBytes() > MAX_TIMELINE_SNAPSHOT_PROJECTION_BYTES
	) {
		const omitted = messages.shift();
		omittedForBudget = true;
		budgetPageCursor =
			messages[0]?.sequence ??
			(omitted === undefined ? budgetPageCursor : omitted.sequence + 1);
		projection = makeProjection();
	}
	if (projectionBytes() > MAX_TIMELINE_SNAPSHOT_PROJECTION_BYTES) {
		return yield* Effect.die(
			new Error(
				`Session ${sessionId} timeline head exceeds the bounded snapshot limit`,
			),
		);
	}
	const olderMessageSequence = omittedForBudget
		? budgetPageCursor
		: messagePage.olderMessageSequence;
	return {
		projection: SessionTimelineProjection.make({
			...projection,
			olderMessageSequence,
		}),
		olderMessageSequence,
		totalMessageCount,
	};
});

export {
	LATEST_TIMELINE_MESSAGE_LIMIT,
	MAX_TIMELINE_SNAPSHOT_PROJECTION_BYTES,
};
