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
	readonly archived: boolean;
	readonly deleted: boolean;
	readonly currentTurnId: string | null;
	readonly openSegments: ReadonlyMap<string, OpenSegment>;
	readonly messageIds: ReadonlySet<string>;
	readonly pendingPermissionIds: ReadonlySet<string>;
	readonly providerId: string | null;
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
	archived: false,
	deleted: false,
	currentTurnId: null,
	openSegments: new Map(),
	messageIds: new Set(),
	pendingPermissionIds: new Set(),
	providerId: null,
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
				version,
			};
		case "SessionTitleSet":
			return { ...state, title: event.title, version };
		case "SessionArchived":
			return { ...state, archived: true, version };
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
			return { ...state, providerId: event.providerId, version };
		case "ProviderDetached":
			return { ...state, providerId: null, version };
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
