import type {
	PermissionMode,
	ResumeStrategy,
	RuntimeMode,
	SessionStatus,
} from "@zuse/contracts";
import type { SessionEvent } from "./events.js";

export type OpenSegment = {
	readonly turnId: string;
	readonly kind: "assistant" | "reasoning" | "tool";
};

export type SessionState = {
	readonly exists: boolean;
	readonly sessionId: string | null;
	readonly chatId: string | null;
	readonly projectId: string | null;
	readonly title: string | null;
	readonly model: string | null;
	readonly status: SessionStatus | null;
	readonly cursor: string | null;
	readonly resumeStrategy: ResumeStrategy | null;
	readonly runtimeMode: RuntimeMode | null;
	readonly worktreeId: string | null;
	readonly permissionMode: PermissionMode | null;
	readonly archived: boolean;
	readonly deleted: boolean;
	readonly currentTurnId: string | null;
	readonly openSegments: ReadonlyMap<string, OpenSegment>;
	readonly messageIds: ReadonlySet<string>;
	readonly pendingPermissionIds: ReadonlySet<string>;
	readonly providerId: string | null;
	readonly attachedProviderId: string | null;
	readonly checkpointIds: ReadonlySet<string>;
	readonly archiveWorktreeIds: ReadonlySet<string>;
	readonly version: number;
};

export const initialSessionState: SessionState = {
	exists: false,
	sessionId: null,
	chatId: null,
	projectId: null,
	title: null,
	model: null,
	status: null,
	cursor: null,
	resumeStrategy: null,
	runtimeMode: null,
	worktreeId: null,
	permissionMode: null,
	archived: false,
	deleted: false,
	currentTurnId: null,
	openSegments: new Map(),
	messageIds: new Set(),
	pendingPermissionIds: new Set(),
	providerId: null,
	attachedProviderId: null,
	checkpointIds: new Set(),
	archiveWorktreeIds: new Set(),
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
				providerId: event.providerId ?? null,
				model: event.model ?? null,
				status: event.status ?? null,
				cursor: event.cursor ?? null,
				resumeStrategy: event.resumeStrategy ?? null,
				runtimeMode: event.runtimeMode ?? null,
				worktreeId: event.worktreeId ?? null,
				permissionMode: event.permissionMode ?? null,
				version,
			};
		case "SessionTitleSet":
			return { ...state, title: event.title, version };
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
			return { ...state, currentTurnId: event.turnId, version };
		case "TurnSettled":
			return { ...state, currentTurnId: null, version };
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
		case "CheckpointRecorded":
			return {
				...state,
				checkpointIds: added(state.checkpointIds, event.checkpointId),
				version,
			};
		case "WorktreeArchiveRequested":
			return {
				...state,
				archiveWorktreeIds: added(state.archiveWorktreeIds, event.worktreeId),
				version,
			};
	}
};

export const evolveAll = (
	state: SessionState,
	events: readonly SessionEvent[],
): SessionState => events.reduce(evolve, state);
