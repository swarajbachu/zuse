import type {
	PermissionMode,
	ResumeStrategy,
	RuntimeMode,
	SessionStatus,
} from "@zuse/contracts";
import { type TitleProvenance, titleProvenanceOrManual } from "../naming.js";
import type { TurnPhase } from "./commands.js";
import type { SessionEvent } from "./events.js";

export type OpenSegment = {
	readonly turnId: string;
	readonly kind: "assistant" | "reasoning" | "tool";
};

export type QueuedTurn = {
	readonly queueId: string;
	readonly inputJson: string;
	readonly position: number;
	readonly createdAt: number;
	readonly ready: boolean;
};

export type ScheduledSuccessor = {
	readonly predecessorTurnId: string;
	readonly turnId: string;
	readonly queueId: string;
	readonly inputJson: string;
};

export type SessionState = {
	readonly exists: boolean;
	readonly sessionId: string | null;
	readonly chatId: string | null;
	readonly projectId: string | null;
	readonly title: string | null;
	readonly titleProvenance: TitleProvenance;
	readonly model: string | null;
	readonly status: SessionStatus | null;
	readonly queuePaused: boolean;
	readonly cursor: string | null;
	readonly resumeStrategy: ResumeStrategy | null;
	readonly runtimeMode: RuntimeMode | null;
	readonly worktreeId: string | null;
	readonly permissionMode: PermissionMode | null;
	readonly archived: boolean;
	readonly deleted: boolean;
	readonly currentTurnId: string | null;
	readonly currentTurnPhase: TurnPhase | null;
	readonly lastSettledTurnId: string | null;
	readonly lastSettlementOutcome: "completed" | "interrupted" | "error" | null;
	readonly settledTurnIds: ReadonlySet<string>;
	readonly queuedTurns: ReadonlyMap<string, QueuedTurn>;
	readonly queueOrder: ReadonlyArray<string>;
	readonly scheduledSuccessor: ScheduledSuccessor | null;
	readonly openSegments: ReadonlyMap<string, OpenSegment>;
	readonly messageIds: ReadonlySet<string>;
	readonly pendingPermissionIds: ReadonlySet<string>;
	readonly providerId: string | null;
	readonly attachedProviderId: string | null;
	readonly version: number;
};

export const initialSessionState: SessionState = {
	exists: false,
	sessionId: null,
	chatId: null,
	projectId: null,
	title: null,
	titleProvenance: "manual",
	model: null,
	status: null,
	queuePaused: false,
	cursor: null,
	resumeStrategy: null,
	runtimeMode: null,
	worktreeId: null,
	permissionMode: null,
	archived: false,
	deleted: false,
	currentTurnId: null,
	currentTurnPhase: null,
	lastSettledTurnId: null,
	lastSettlementOutcome: null,
	settledTurnIds: new Set(),
	queuedTurns: new Map(),
	queueOrder: [],
	scheduledSuccessor: null,
	openSegments: new Map(),
	messageIds: new Set(),
	pendingPermissionIds: new Set(),
	providerId: null,
	attachedProviderId: null,
	version: 0,
};

const added = <A>(source: ReadonlySet<A>, value: A): ReadonlySet<A> =>
	new Set([...source, value]);
const removed = <A>(source: ReadonlySet<A>, value: A): ReadonlySet<A> => {
	const next = new Set(source);
	next.delete(value);
	return next;
};

export const evolve = (
	state: SessionState,
	event: SessionEvent,
): SessionState => {
	const version = state.version + 1;
	switch (event._tag) {
		case "SessionCreated":
			return {
				...state,
				exists: true,
				sessionId: event.sessionId,
				chatId: event.chatId,
				projectId: event.projectId,
				title: event.title ?? null,
				titleProvenance: titleProvenanceOrManual(event.titleProvenance),
				providerId: event.providerId ?? null,
				model: event.model ?? null,
				status: event.status ?? null,
				cursor: event.cursor ?? null,
				resumeStrategy: event.resumeStrategy ?? null,
				runtimeMode: event.runtimeMode ?? null,
				worktreeId: event.worktreeId ?? null,
				permissionMode: event.permissionMode ?? null,
				queuePaused: event.queuePaused ?? false,
				version,
			};
		case "SessionTitleSet":
			return {
				...state,
				title: event.title,
				titleProvenance: titleProvenanceOrManual(event.titleProvenance),
				version,
			};
		case "SessionModelSet":
			return { ...state, model: event.model, version };
		case "SessionProviderSet":
			return {
				...state,
				providerId: event.providerId,
				model: event.model,
				cursor: null,
				resumeStrategy: "none",
				version,
			};
		case "SessionRuntimeModeSet":
			return { ...state, runtimeMode: event.runtimeMode, version };
		case "SessionPermissionModeSet":
			return { ...state, permissionMode: event.permissionMode, version };
		case "SessionWorktreeSet":
			return {
				...state,
				worktreeId: event.worktreeId,
				cursor: null,
				resumeStrategy: "none",
				version,
			};
		case "SessionStatusSet":
			return { ...state, status: event.status, version };
		case "SessionQueuePausedSet":
			return { ...state, queuePaused: event.paused, version };
		case "SessionResumeSet":
			return {
				...state,
				cursor: event.cursor,
				resumeStrategy: event.resumeStrategy,
				version,
			};
		case "SessionArchived":
			return { ...state, archived: true, version };
		case "SessionUnarchived":
			return { ...state, archived: false, version };
		case "SessionDeleted":
			return { ...state, deleted: true, version };
		case "TurnStarted":
			return {
				...state,
				currentTurnId: event.turnId,
				currentTurnPhase: "running",
				version,
			};
		case "ProviderTurnRequested":
			return { ...state, version };
		case "TurnInterruptRequested":
			return { ...state, currentTurnPhase: "interrupt-requested", version };
		case "TurnInterruptAcknowledged":
			return { ...state, currentTurnPhase: "interrupt-acknowledged", version };
		case "TurnInterruptFailed":
			return { ...state, version };
		case "TurnSettled":
			return {
				...state,
				currentTurnId: null,
				currentTurnPhase: null,
				lastSettledTurnId: event.turnId,
				lastSettlementOutcome: event.outcome,
				settledTurnIds: added(state.settledTurnIds, event.turnId),
				version,
			};
		case "QueuedTurnEnqueued": {
			const queuedTurns = new Map(state.queuedTurns);
			queuedTurns.set(event.queueId, event);
			return {
				...state,
				queuedTurns,
				queueOrder: [...state.queueOrder, event.queueId],
				version,
			};
		}
		case "QueuedTurnUpdated": {
			const current = state.queuedTurns.get(event.queueId);
			if (current === undefined) return { ...state, version };
			const queuedTurns = new Map(state.queuedTurns);
			queuedTurns.set(event.queueId, {
				...current,
				inputJson: event.inputJson,
				ready: event.ready,
			});
			return { ...state, queuedTurns, version };
		}
		case "QueuedTurnRemoved":
		case "QueuedTurnClaimed": {
			const queuedTurns = new Map(state.queuedTurns);
			queuedTurns.delete(event.queueId);
			return {
				...state,
				queuedTurns,
				queueOrder: state.queueOrder.filter((id) => id !== event.queueId),
				version,
			};
		}
		case "QueuedTurnsReordered":
			return { ...state, queueOrder: event.queueIds, version };
		case "SuccessorTurnScheduled":
			return {
				...state,
				scheduledSuccessor: {
					predecessorTurnId: event.predecessorTurnId,
					turnId: event.turnId,
					queueId: event.queueId,
					inputJson: event.inputJson,
				},
				version,
			};
		case "ScheduledSuccessorReady":
			return { ...state, scheduledSuccessor: null, version };
		case "MessagePersisted":
			return {
				...state,
				messageIds: added(state.messageIds, event.messageId),
				version,
			};
		case "SegmentOpened": {
			const openSegments = new Map(state.openSegments);
			openSegments.set(event.segmentId, {
				turnId: event.turnId,
				kind: event.kind,
			});
			return { ...state, openSegments, version };
		}
		case "SegmentSettled": {
			const openSegments = new Map(state.openSegments);
			openSegments.delete(event.segmentId);
			return { ...state, openSegments, version };
		}
		case "PermissionRequested":
			return {
				...state,
				pendingPermissionIds: added(
					state.pendingPermissionIds,
					event.requestId,
				),
				version,
			};
		case "PermissionResolved":
			return {
				...state,
				pendingPermissionIds: removed(
					state.pendingPermissionIds,
					event.requestId,
				),
				version,
			};
		case "ProviderAttached":
			return { ...state, attachedProviderId: event.providerId, version };
		case "ProviderStopRequested":
			return { ...state, version };
		case "ProviderDetached":
			return { ...state, attachedProviderId: null, version };
	}
};

export const evolveAll = (
	state: SessionState,
	events: readonly SessionEvent[],
): SessionState => events.reduce(evolve, state);
