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
	QueuedMessage,
	QueueState,
	type SessionId,
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

export type SessionTimelineSnapshot = {
	readonly projection: SessionTimelineProjection;
	readonly olderMessageSequence: number | null;
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
const decodeComposer = Schema.decodeUnknownResult(
	Schema.fromJsonString(ComposerInput),
);

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
	};
});

export {
	LATEST_TIMELINE_MESSAGE_LIMIT,
	MAX_TIMELINE_SNAPSHOT_PROJECTION_BYTES,
};
