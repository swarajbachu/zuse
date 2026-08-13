import type { SessionId, SessionStatus } from "@zuse/contracts";
import {
	isSessionTurnActive,
	runtimeStateFromStatus,
	type SessionRuntimeState,
} from "../lib/session-runtime-state.ts";
import { createAtomStore as create } from "../state/atom-store.ts";

type SessionTerminalListener = (
	sessionId: SessionId,
	outcome: "idle" | "failed",
) => void;

type SessionRuntimeStore = {
	/** Last-known catalog lifecycle, used only when no timeline resource is retained. */
	readonly bySession: Readonly<Record<string, SessionRuntimeState>>;
	readonly observeSummary: (
		sessionId: SessionId,
		status: SessionStatus,
	) => void;
	readonly observeSummaries: (
		summaries: ReadonlyArray<{
			readonly sessionId: SessionId;
			readonly status: SessionStatus;
		}>,
	) => void;
	readonly remove: (sessionId: SessionId) => void;
};

const terminalListeners = new Set<SessionTerminalListener>();
const completionArmedBySession = new Set<SessionId>();

const emitTerminal = (
	sessionId: SessionId,
	outcome: "idle" | "failed",
): void => {
	for (const listener of terminalListeners) listener(sessionId, outcome);
};

const observeCompletion = (
	sessionId: SessionId,
	state: SessionRuntimeState,
): void => {
	if (isSessionTurnActive(state)) {
		completionArmedBySession.add(sessionId);
		return;
	}
	if (
		(state === "idle" || state === "failed") &&
		completionArmedBySession.delete(sessionId)
	) {
		emitTerminal(sessionId, state);
	}
};

export const useSessionRuntimeStore = create<SessionRuntimeStore>(
	(set, get) => ({
		bySession: {},
		observeSummary: (sessionId, status) => {
			get().observeSummaries([{ sessionId, status }]);
		},
		observeSummaries: (summaries) => {
			if (summaries.length === 0) return;
			const current = get().bySession;
			let next: Record<string, SessionRuntimeState> | null = null;
			const observed: Array<readonly [SessionId, SessionRuntimeState]> = [];
			for (const { sessionId, status } of summaries) {
				const state = runtimeStateFromStatus(status);
				if (current[sessionId] === state) continue;
				next ??= { ...current };
				next[sessionId] = state;
				observed.push([sessionId, state]);
			}
			if (next === null) return;
			set({ bySession: next });
			for (const [sessionId, state] of observed) {
				observeCompletion(sessionId, state);
			}
		},
		remove: (sessionId) => {
			completionArmedBySession.delete(sessionId);
			if (get().bySession[sessionId] === undefined) return;
			const bySession = { ...get().bySession };
			delete bySession[sessionId];
			set({ bySession });
		},
	}),
);

export const resetSessionRuntimeForTest = (): void => {
	completionArmedBySession.clear();
	terminalListeners.clear();
	useSessionRuntimeStore.setState({ bySession: {} });
};

export const subscribeSessionTerminals = (
	listener: SessionTerminalListener,
): (() => void) => {
	terminalListeners.add(listener);
	return () => {
		terminalListeners.delete(listener);
	};
};
