import {
	AgentTurnId,
	AttemptId,
	DEFAULT_PERMISSION_MODE,
	DEFAULT_RUNTIME_MODE,
	MAX_SESSION_QUEUE_ITEMS,
	MAX_SESSION_QUEUE_TOTAL_BYTES,
	Message,
	MessageContent,
	MessageId,
	MessageRole,
	PermissionRequest,
	ProviderThreadId,
	QueuedMessage,
	QueuedMessageInput,
	QueueState,
	RuntimeMode,
	type SessionExecutionStep,
	type SessionId,
	type SessionInteraction,
	SessionTimelineProjection,
	SessionTimelineTurnPhase,
	type SessionTurn,
	TurnStatus,
} from "@zuse/contracts";
import { Effect, Result, Schema } from "effect";
import type { SqlClient } from "effect/unstable/sql";
import { loadDeferredToolDetailProjector } from "./session-timeline-wire.ts";

import type { SqlSessionQueryError } from "./sql-session-queries.js";
import { makeSqlSessionQueries } from "./sql-session-queries.js";

const LATEST_TIMELINE_MESSAGE_LIMIT = 100;

const MAX_TIMELINE_SNAPSHOT_PROJECTION_BYTES = 900 * 1024;

interface TimelineHeadRow {
	readonly status: "booting" | "idle" | "running" | "closed" | "error";
	readonly runtime_mode: string;
	readonly permission_mode: string;
	readonly queue_paused: number;
	readonly turn_count: number;
	readonly turn_id: string | null;
	readonly turn_ordinal: number | null;
	readonly turn_status: string | null;
	readonly turn_phase: string | null;
	readonly turn_provider_thread_id: string | null;
	readonly attempt_id: string | null;
	readonly attempt_ordinal: number | null;
	readonly attempt_reason: string | null;
	readonly turn_requested_at: string | null;
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
	readonly expired: number;
	readonly content_json: string;
	readonly created_at: string;
}

interface PendingPermissionRow {
	readonly request_json: string;
	readonly expired: number;
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
	Schema.fromJsonString(QueuedMessageInput),
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
		SELECT request_json AS content_json, requested_at AS created_at,
			CASE WHEN status = 'expired' THEN 1 ELSE 0 END AS expired
		FROM session_inputs
		WHERE session_id = ${sessionId} AND kind = 'question' AND (status = 'pending' OR (status = 'expired' AND awaiting_dismissal = 1))
			AND request_json IS NOT NULL
		ORDER BY requested_sequence LIMIT ${MAX_PENDING_SESSION_INTERACTIONS + 1}
	`;
	const permissionRows = yield* sql<PendingPermissionRow>`
		SELECT request_json, CASE WHEN status = 'expired' THEN 1 ELSE 0 END AS expired
		FROM session_inputs
		WHERE session_id = ${sessionId} AND kind = 'permission' AND status IN ('pending', 'expired')
			AND request_json IS NOT NULL
		ORDER BY requested_sequence LIMIT ${MAX_PENDING_SESSION_INTERACTIONS + 1}
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
	const planRows = yield* sql<{
		request_id: string;
		requested_at: string;
		status: string;
		awaiting_dismissal: number;
	}>`SELECT request_id,requested_at,status,awaiting_dismissal FROM session_inputs WHERE session_id=${sessionId} AND kind='plan' AND request_json IS NOT NULL AND status IN ('pending','expired') ORDER BY requested_sequence DESC LIMIT 100`;
	const interactions: SessionInteraction[] = planRows.map((row) => ({
		_tag: "Plan",
		id: row.request_id as import("@zuse/contracts").AgentItemId,
		requestedAt: new Date(row.requested_at),
		...(row.status === "expired"
			? {
					recoveryState:
						row.awaiting_dismissal === 2
							? ("uncertain" as const)
							: ("expired" as const),
				}
			: {}),
	}));
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
			...(row.expired === 1 ? { recoveryState: "expired" as const } : {}),
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
			request:
				row.expired === 1
					? PermissionRequest.make({
							...request.success,
							recoveryState: "expired",
						})
					: request.success,
		});
	}
	interactions.sort((left, right) => {
		const leftAt =
			left._tag !== "Permission"
				? left.requestedAt.getTime()
				: left.request.requestedAt.getTime();
		const rightAt =
			right._tag !== "Permission"
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
	maxBytes?: number,
): Effect.fn.Return<SessionTimelineMessagePage, SqlSessionQueryError> {
	const page = yield* makeSqlSessionQueries(sql).messagePage({
		sessionId,
		beforeSequence,
		limit,
		maxBytes,
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

const activeTurnFromHead = (head: TimelineHeadRow): SessionTurn | null => {
	if (
		head.turn_id === null ||
		head.turn_ordinal === null ||
		head.attempt_id === null ||
		head.turn_requested_at === null
	) {
		return null;
	}
	const status = Schema.decodeUnknownResult(TurnStatus)(head.turn_status);
	const phase = Schema.decodeUnknownResult(SessionTimelineTurnPhase)(
		head.turn_phase ?? "running",
	);
	const reason = Schema.decodeUnknownResult(
		Schema.Literals(["initial", "retry", "provider_recovery"]),
	)(head.attempt_reason);
	return {
		id: AgentTurnId.make(head.turn_id),
		ordinal: head.turn_ordinal,
		status: Result.isSuccess(status) ? status.success : "running",
		phase: Result.isSuccess(phase) ? phase.success : "running",
		attempt: {
			id: AttemptId.make(head.attempt_id),
			ordinal: head.attempt_ordinal ?? 1,
			reason: Result.isSuccess(reason) ? reason.success : "initial",
		},
		providerThreadId:
			head.turn_provider_thread_id === null
				? null
				: ProviderThreadId.make(head.turn_provider_thread_id),
		requestedAt: new Date(head.turn_requested_at),
		completedAt: null,
	};
};

/** Read a bounded, fully materialized timeline without folding event history. */
export const readSessionTimelineSnapshot = Effect.fn(
	"readSessionTimelineSnapshot",
)(function* (
	sql: SqlClient.SqlClient,
	sessionId: SessionId,
	deferToolDetails = false,
): Effect.fn.Return<SessionTimelineSnapshot, SqlSessionQueryError> {
	const queries = makeSqlSessionQueries(sql);
	const headRows = yield* sql<TimelineHeadRow>`
		SELECT s.status, s.runtime_mode, s.permission_mode, s.queue_paused,
			(SELECT COALESCE(MAX(ordinal), 0) FROM session_turns
				WHERE session_id = s.id) AS turn_count,
			t.id AS turn_id, t.ordinal AS turn_ordinal, t.status AS turn_status,
			t.phase AS turn_phase, t.provider_thread_id AS turn_provider_thread_id,
			t.active_attempt_id AS attempt_id, t.attempt_ordinal AS attempt_ordinal,
			t.attempt_reason AS attempt_reason, t.requested_at AS turn_requested_at
		FROM sessions s
		LEFT JOIN session_turns t
			ON t.session_id = s.id AND t.status IN ('starting', 'running', 'finalizing')
		WHERE s.id = ${sessionId}
		ORDER BY t.ordinal DESC
		LIMIT 1
	`;
	const head = headRows[0];
	if (head === undefined) {
		yield* queries.get(sessionId);
		return yield* Effect.die("Session query existed without a timeline head");
	}
	const messagePage = yield* readSessionTimelineMessagePage(
		sql,
		sessionId,
		undefined,
		LATEST_TIMELINE_MESSAGE_LIMIT,
		Number.MAX_SAFE_INTEGER,
	);
	const messageCountRows = yield* sql<{ readonly count: number }>`
		SELECT COUNT(*) AS count FROM messages WHERE session_id = ${sessionId}
	`;
	const totalMessageCount = messageCountRows[0]?.count ?? 0;
	const projector = deferToolDetails
		? yield* loadDeferredToolDetailProjector(sql, sessionId)
		: null;
	const messages = messagePage.items.map((item) =>
		projector === null
			? item
			: { ...item, message: projector.message(item.message) },
	);
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
				actor: input.success.actor,
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
	const activeTurn = activeTurnFromHead(head);
	const runtimeMode = Schema.decodeUnknownResult(RuntimeMode)(
		head.runtime_mode,
	);
	const permissionMode = Schema.decodeUnknownResult(
		Schema.Literals(["default", "plan", "acceptEdits"]),
	)(head.permission_mode);
	const interactions = yield* readPendingInteractions(sql, sessionId);
	const stepRows =
		yield* sql<SessionExecutionStep>`SELECT 'unsupported' AS checkpointCapability,id,turn_id AS turnId,attempt_id AS attemptId,item_id AS itemId,parent_item_id AS parentItemId,kind,label,status,child_session_id AS childSessionId,native_child_id AS nativeChildId,root_completed_at AS rootCompletedAt,created_at AS createdAt,updated_at AS updatedAt FROM session_execution_steps WHERE session_id=${sessionId} ORDER BY created_at DESC,id LIMIT 201`;
	const executionSteps = stepRows.slice(0, 200);
	let executionStepsTruncated = stepRows.length > 200;
	const makeProjection = () =>
		SessionTimelineProjection.make({
			messages: messages.map(({ message }) => message),
			executionSteps,
			executionStepsTruncated,
			olderMessageSequence: null,
			status: head.status,
			activeTurn,
			turnCount: head.turn_count,
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
	while (
		executionSteps.length > 0 &&
		projectionBytes() > MAX_TIMELINE_SNAPSHOT_PROJECTION_BYTES
	) {
		executionSteps.pop();
		executionStepsTruncated = true;
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
