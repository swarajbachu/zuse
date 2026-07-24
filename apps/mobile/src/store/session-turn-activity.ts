import type { SessionStatus } from "@zuse/contracts";
import { Atom } from "effect/unstable/reactivity";

import { appAtomRegistry } from "./registry";

export type SessionTurnActivity = "idle" | "starting" | "running";

export const sessionTurnActivityBySessionAtom = Atom.make<
	Record<string, SessionTurnActivity>
>({}).pipe(Atom.keepAlive);

export const sessionTurnActivityAtom = Atom.family((sessionKey: string) =>
	Atom.make((get) => get(sessionTurnActivityBySessionAtom)[sessionKey]),
);

const setSessionTurnActivity = (
	sessionKey: string,
	activity: SessionTurnActivity,
): void => {
	appAtomRegistry.update(sessionTurnActivityBySessionAtom, (state) =>
		state[sessionKey] === activity
			? state
			: {
					...state,
					[sessionKey]: activity,
				},
	);
};

/** Covers the interval between publishing a message and the first stream frame. */
export const markSessionTurnStarting = (sessionKey: string): void => {
	setSessionTurnActivity(sessionKey, "starting");
};

export const markSessionTurnStartFailed = (sessionKey: string): void => {
	setSessionTurnActivity(sessionKey, "idle");
};

/** The session timeline is authoritative once its projection arrives. */
export const syncSessionTurnActivity = (
	sessionKey: string,
	running: boolean,
): void => {
	if (running) {
		setSessionTurnActivity(sessionKey, "running");
		return;
	}
	// A retained timeline may emit an idle snapshot after submit but before the
	// new turn-start frame. The explicit failure callback owns cancelling this
	// optimistic bridge; a stale idle frame must not erase it.
	if (
		appAtomRegistry.get(sessionTurnActivityBySessionAtom)[sessionKey] ===
		"starting"
	) {
		return;
	}
	setSessionTurnActivity(sessionKey, "idle");
};

export const resetSessionTurnActivity = (): void => {
	appAtomRegistry.set(sessionTurnActivityBySessionAtom, {});
};

export const resolveSessionStatus = (
	status: SessionStatus | undefined,
	activity: SessionTurnActivity | undefined,
): SessionStatus | undefined => {
	switch (activity) {
		case "starting":
			return "booting";
		case "running":
			return "running";
		case "idle":
			return status === "running" || status === "booting" ? "idle" : status;
		default:
			return status;
	}
};
