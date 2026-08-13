import type { SessionRef } from "@zuse/client-runtime/resource-ref";
import type { SessionId } from "@zuse/contracts";

import { CHAT_LIST_ANCHOR_OFFSET } from "./chat-list-anchor.ts";
import {
	type ChatTimelineRow,
	rowAnchorMessageId,
} from "./chat-timeline-rows.ts";
import type { TimelineListMeasurementState } from "./timeline-scroll-anchoring.ts";
import type { TranscriptScrollMode } from "./transcript-scroll-coordinator.ts";

export const TIMELINE_READING_POSITION_SCHEMA_VERSION = 1;

export interface TimelineReadingPosition {
	readonly schemaVersion: typeof TIMELINE_READING_POSITION_SCHEMA_VERSION;
	readonly sessionId: SessionId;
	readonly userTurnMessageId: string;
	readonly viewportOffset: number;
	readonly updatedAt: number;
}

export interface TimelineReadingPositionStore {
	readonly load: (ref: SessionRef) => Promise<TimelineReadingPosition | null>;
	readonly save: (
		ref: SessionRef,
		position: TimelineReadingPosition,
	) => Promise<void>;
	readonly remove: (ref: SessionRef) => Promise<void>;
}

export function encodeTimelineReadingPosition(
	position: TimelineReadingPosition,
): unknown {
	return { ...position };
}

export function decodeTimelineReadingPosition(
	value: unknown,
): TimelineReadingPosition | null {
	if (typeof value !== "object" || value === null) return null;
	const record = value as Record<string, unknown>;
	if (
		record.schemaVersion !== TIMELINE_READING_POSITION_SCHEMA_VERSION ||
		typeof record.sessionId !== "string" ||
		record.sessionId.length === 0 ||
		typeof record.userTurnMessageId !== "string" ||
		record.userTurnMessageId.length === 0 ||
		typeof record.viewportOffset !== "number" ||
		!Number.isFinite(record.viewportOffset) ||
		typeof record.updatedAt !== "number" ||
		!Number.isFinite(record.updatedAt)
	) {
		return null;
	}
	return record as unknown as TimelineReadingPosition;
}

export function resolveReadingPositionTarget(
	rows: ReadonlyArray<ChatTimelineRow>,
	messageId: string,
): { readonly index: number; readonly messageId: string } | null {
	let latest: { readonly index: number; readonly messageId: string } | null =
		null;
	for (const [index, row] of rows.entries()) {
		const candidate = rowAnchorMessageId(row);
		if (candidate === null) continue;
		const target = { index, messageId: candidate };
		if (candidate === messageId) return target;
		latest = target;
	}
	return latest;
}

export function resolveInitialTimelineTarget({
	rows,
	position,
	recoverAtLiveEdge,
}: {
	readonly rows: ReadonlyArray<ChatTimelineRow>;
	readonly position: TimelineReadingPosition | null | undefined;
	readonly recoverAtLiveEdge: boolean;
}): {
	readonly index: number;
	readonly messageId: string;
	readonly viewportOffset: number;
} | null {
	if (recoverAtLiveEdge) return null;
	const target = resolveReadingPositionTarget(
		rows,
		position?.userTurnMessageId ?? "",
	);
	if (target === null) return null;
	return {
		...target,
		viewportOffset:
			position !== null &&
			position !== undefined &&
			target.messageId === position.userTurnMessageId
				? position.viewportOffset
				: CHAT_LIST_ANCHOR_OFFSET,
	};
}

export function resolveTimelineReadingPosition({
	sessionId,
	rows,
	mode,
	measurement,
	now = Date.now(),
}: {
	readonly sessionId: SessionId;
	readonly rows: ReadonlyArray<ChatTimelineRow>;
	readonly mode: TranscriptScrollMode;
	readonly measurement: TimelineListMeasurementState;
	readonly now?: number;
}): TimelineReadingPosition | null {
	const userTurns = rows.flatMap((row, index) => {
		const messageId = rowAnchorMessageId(row);
		return messageId === null ? [] : [{ index, messageId }];
	});
	if (userTurns.length === 0) return null;

	if (mode === "following" || mode === "anchoring-turn") {
		const latest = userTurns.at(-1);
		if (latest === undefined) return null;
		return {
			schemaVersion: TIMELINE_READING_POSITION_SCHEMA_VERSION,
			sessionId,
			userTurnMessageId: latest.messageId,
			viewportOffset: CHAT_LIST_ANCHOR_OFFSET,
			updatedAt: now,
		};
	}

	let active = userTurns[0];
	for (const turn of userTurns) {
		const top = measurement.positionAtIndex(turn.index);
		if (!Number.isFinite(top)) continue;
		if ((top ?? 0) <= measurement.scroll + CHAT_LIST_ANCHOR_OFFSET) {
			active = turn;
			continue;
		}
		break;
	}
	if (active === undefined) return null;
	const top = measurement.positionAtIndex(active.index);
	if (!Number.isFinite(top)) return null;

	return {
		schemaVersion: TIMELINE_READING_POSITION_SCHEMA_VERSION,
		sessionId,
		userTurnMessageId: active.messageId,
		viewportOffset: (top ?? 0) - measurement.scroll,
		updatedAt: now,
	};
}
