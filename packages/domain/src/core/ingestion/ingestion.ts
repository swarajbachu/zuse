import type { SegmentKind, SettlementOutcome } from "../commands.js";
import type { SessionEvent } from "../events.js";
import type { SessionState } from "../state.js";

export type IngestionEvent =
	| {
			readonly _tag: "SegmentStarted";
			readonly segmentId: string;
			readonly kind: SegmentKind;
			readonly at: number;
	  }
	| {
			readonly _tag: "SegmentFinished";
			readonly segmentId: string;
			readonly at: number;
	  };

export const ingest = (
	state: SessionState,
	turnId: string,
	event: IngestionEvent,
): readonly SessionEvent[] => {
	if (state.currentTurnId !== turnId) return [];
	if (event._tag === "SegmentStarted") {
		return state.openSegments.has(event.segmentId)
			? []
			: [
					{
						_tag: "SegmentOpened",
						turnId,
						segmentId: event.segmentId,
						kind: event.kind,
						openedAt: event.at,
					},
				];
	}
	const segment = state.openSegments.get(event.segmentId);
	return segment?.turnId === turnId
		? [
				{
					_tag: "SegmentSettled",
					turnId,
					segmentId: event.segmentId,
					outcome: "completed",
					settledAt: event.at,
				},
			]
		: [];
};

export const settleTruncatedTurn = (
	state: SessionState,
	turnId: string,
	outcome: SettlementOutcome,
	settledAt: number,
): readonly SessionEvent[] => {
	if (state.currentTurnId !== turnId) return [];
	const events: SessionEvent[] = [];
	for (const [segmentId, segment] of state.openSegments) {
		if (segment.turnId !== turnId) continue;
		events.push({
			_tag: "SegmentSettled",
			turnId,
			segmentId,
			outcome,
			settledAt,
		});
	}
	events.push({ _tag: "TurnSettled", turnId, outcome, settledAt });
	return events;
};
