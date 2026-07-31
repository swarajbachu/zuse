import type {
	AgentTurnId,
	SessionId,
	SessionStatus,
	SessionTimelineProjection,
} from "@zuse/contracts";
import {
	effectiveSessionRuntimeState,
	isSessionTurnActive,
	runtimeStateFromStatus,
	type SessionRuntimeState,
} from "../lib/session-runtime-state.ts";
import { createAtomStore as create } from "../state/atom-store.ts";

type CommandProjection =
	| {
			readonly kind: "send";
			readonly phase: "pending";
			readonly state: "starting";
			readonly observedVersion: number;
	  }
	| {
			readonly kind: "stop";
			readonly phase: "pending";
			readonly state: "stopping";
			readonly observedVersion: number;
			readonly turnId: AgentTurnId | null;
	  }
	| {
			readonly kind: "send";
			readonly phase: "acknowledged";
			readonly state: "failed";
			readonly observedVersion: number;
	  }
	| {
			readonly kind: "stop";
			readonly phase: "acknowledged";
			readonly state: "idle";
			readonly observedVersion: number;
			readonly turnId: AgentTurnId | null;
	  };

type TimelineFact = {
	readonly state: SessionRuntimeState;
	readonly turnId: AgentTurnId | null;
};

type SessionTerminalListener = (
	sessionId: SessionId,
	outcome: "idle" | "failed",
) => void;

type SessionRuntimeStore = {
	/** Effective lifecycle state. Private projector facts never reach UI code. */
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
	readonly observeTimeline: (
		sessionId: SessionId,
		projection: SessionTimelineProjection,
		version: number,
	) => void;
	readonly beginOptimisticTurn: (sessionId: SessionId) => void;
	readonly beginOptimisticStop: (sessionId: SessionId) => void;
	readonly rollbackOptimisticStop: (sessionId: SessionId) => void;
	readonly settleOptimisticTurn: (
		sessionId: SessionId,
		outcome: "idle" | "failed",
	) => void;
	readonly releaseTimeline: (sessionId: SessionId) => void;
	readonly remove: (sessionId: SessionId) => void;
};

const summaryBySession = new Map<SessionId, SessionRuntimeState>();
const timelineBySession = new Map<SessionId, TimelineFact>();
const timelineVersionBySession = new Map<SessionId, number>();
const commandBySession = new Map<SessionId, CommandProjection>();
const terminalListeners = new Set<SessionTerminalListener>();
const completionArmedBySession = new Set<SessionId>();

const stateFromTimeline = (
	projection: SessionTimelineProjection,
): SessionRuntimeState => {
	if (projection.status === "error") return "failed";
	if (projection.status === "booting") return "starting";
	const phase = projection.currentTurn?.phase;
	if (phase === "interrupt-requested" || phase === "interrupt-acknowledged") {
		return "stopping";
	}
	if (projection.currentTurn !== null || projection.status === "running") {
		return "running";
	}
	return "idle";
};

const effectiveState = (sessionId: SessionId): SessionRuntimeState =>
	commandBySession.get(sessionId)?.state ??
	timelineBySession.get(sessionId)?.state ??
	summaryBySession.get(sessionId) ??
	"idle";

const currentTimelineVersion = (sessionId: SessionId): number =>
	timelineVersionBySession.get(sessionId) ?? -1;

const emitTerminal = (
	sessionId: SessionId,
	outcome: "idle" | "failed",
): void => {
	for (const listener of terminalListeners) listener(sessionId, outcome);
};

const observeDurableCompletionState = (
	sessionId: SessionId,
	state: SessionRuntimeState,
): void => {
	if (isSessionTurnActive(state)) {
		completionArmedBySession.add(sessionId);
		return;
	}
	if (state === "failed") {
		if (completionArmedBySession.delete(sessionId)) {
			emitTerminal(sessionId, "failed");
		}
		return;
	}
	if (state !== "idle" || !completionArmedBySession.delete(sessionId)) return;
	emitTerminal(sessionId, "idle");
};

const durableTimelineSupersedesCommand = (
	command: CommandProjection,
	timeline: TimelineFact,
	version: number,
): boolean => {
	if (timeline.state === "idle" || timeline.state === "failed") return true;
	if (command.kind === "send") return version > command.observedVersion;
	if (command.phase === "pending") return false;
	return (
		version > command.observedVersion &&
		timeline.state === "running" &&
		timeline.turnId !== command.turnId
	);
};

const publishChanged = (
	sessionIds: ReadonlySet<SessionId>,
	set: (
		patch:
			| Partial<SessionRuntimeStore>
			| ((state: SessionRuntimeStore) => Partial<SessionRuntimeStore>),
	) => void,
	get: () => SessionRuntimeStore,
): void => {
	const current = get().bySession;
	let next: Record<string, SessionRuntimeState> | null = null;
	for (const sessionId of sessionIds) {
		const effective = effectiveState(sessionId);
		if (effectiveSessionRuntimeState(current[sessionId]) === effective)
			continue;
		next ??= { ...current };
		next[sessionId] = effective;
	}
	if (next !== null) set({ bySession: next });
};

export const useSessionRuntimeStore = create<SessionRuntimeStore>(
	(set, get) => ({
		bySession: {},
		observeSummary: (sessionId, status) => {
			get().observeSummaries([{ sessionId, status }]);
		},
		observeSummaries: (summaries) => {
			if (summaries.length === 0) return;
			const changed = new Set<SessionId>();
			const completionStates = new Map<SessionId, SessionRuntimeState>();
			for (const { sessionId, status } of summaries) {
				const state = runtimeStateFromStatus(status);
				const previous = summaryBySession.get(sessionId);
				if (previous === state) continue;
				summaryBySession.set(sessionId, state);
				changed.add(sessionId);
				if (
					timelineBySession.get(sessionId) === undefined &&
					(state === "running" || state === "idle" || state === "failed")
				) {
					completionStates.set(sessionId, state);
				}
			}
			publishChanged(changed, set, get);
			for (const [sessionId, state] of completionStates) {
				observeDurableCompletionState(sessionId, state);
			}
		},
		observeTimeline: (sessionId, projection, version) => {
			const highWater = timelineVersionBySession.get(sessionId);
			if (highWater !== undefined && version <= highWater) return;
			const timeline = {
				state: stateFromTimeline(projection),
				turnId: projection.currentTurn?.turnId ?? null,
			} satisfies TimelineFact;
			timelineVersionBySession.set(sessionId, version);
			timelineBySession.set(sessionId, timeline);
			const command = commandBySession.get(sessionId);
			if (
				command !== undefined &&
				durableTimelineSupersedesCommand(command, timeline, version)
			) {
				commandBySession.delete(sessionId);
			}
			publishChanged(new Set([sessionId]), set, get);
			observeDurableCompletionState(sessionId, timeline.state);
		},
		beginOptimisticTurn: (sessionId) => {
			commandBySession.set(sessionId, {
				kind: "send",
				phase: "pending",
				state: "starting",
				observedVersion: currentTimelineVersion(sessionId),
			});
			publishChanged(new Set([sessionId]), set, get);
		},
		beginOptimisticStop: (sessionId) => {
			commandBySession.set(sessionId, {
				kind: "stop",
				phase: "pending",
				state: "stopping",
				observedVersion: currentTimelineVersion(sessionId),
				turnId: timelineBySession.get(sessionId)?.turnId ?? null,
			});
			publishChanged(new Set([sessionId]), set, get);
		},
		rollbackOptimisticStop: (sessionId) => {
			const command = commandBySession.get(sessionId);
			if (command?.phase !== "pending" || command.state !== "stopping") return;
			commandBySession.delete(sessionId);
			publishChanged(new Set([sessionId]), set, get);
		},
		settleOptimisticTurn: (sessionId, outcome) => {
			const command = commandBySession.get(sessionId);
			if (command?.phase !== "pending") return;
			if (command.kind === "send" && outcome === "failed") {
				commandBySession.set(sessionId, {
					kind: "send",
					phase: "acknowledged",
					state: "failed",
					observedVersion: currentTimelineVersion(sessionId),
				});
			} else if (command.kind === "stop" && outcome === "idle") {
				commandBySession.set(sessionId, {
					...command,
					phase: "acknowledged",
					state: "idle",
					observedVersion: currentTimelineVersion(sessionId),
				});
			} else {
				return;
			}
			publishChanged(new Set([sessionId]), set, get);
		},
		releaseTimeline: (sessionId) => {
			timelineBySession.delete(sessionId);
			const command = commandBySession.get(sessionId);
			if (command?.phase === "pending") commandBySession.delete(sessionId);
			publishChanged(new Set([sessionId]), set, get);
			const summary = summaryBySession.get(sessionId);
			if (summary === "idle" || summary === "failed") {
				observeDurableCompletionState(sessionId, summary);
			}
		},
		remove: (sessionId) => {
			summaryBySession.delete(sessionId);
			timelineBySession.delete(sessionId);
			timelineVersionBySession.delete(sessionId);
			commandBySession.delete(sessionId);
			completionArmedBySession.delete(sessionId);
			if (get().bySession[sessionId] === undefined) return;
			const bySession = { ...get().bySession };
			delete bySession[sessionId];
			set({ bySession });
		},
	}),
);

export const resetSessionRuntimeForTest = (): void => {
	summaryBySession.clear();
	timelineBySession.clear();
	timelineVersionBySession.clear();
	commandBySession.clear();
	completionArmedBySession.clear();
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
