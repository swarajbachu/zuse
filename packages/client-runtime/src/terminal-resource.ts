import type { PtyId } from "@zuse/contracts";

export type TerminalProcessPhase =
	| "connecting"
	| "reconnecting"
	| "running"
	| "exited"
	| "failed";

export type TerminalReplayGap = Readonly<{
	requestedAfter: number;
	earliestAvailable: number;
	latestAvailable: number;
}>;

export type TerminalFailure = Readonly<{
	kind: "replay-gap" | "process-missing" | "stream-ended" | "output-failed";
	message: string;
	gap: TerminalReplayGap | null;
}>;

/**
 * Canonical terminal metadata. Output bytes deliberately never enter this
 * state: they flow directly from the resource driver to the terminal sink.
 */
export type TerminalResourceState = Readonly<{
	terminalId: PtyId;
	processEpoch: string;
	phase: TerminalProcessPhase;
	outputSequence: number;
	exitCode: number | null;
	signal: number | null;
	failure: TerminalFailure | null;
}>;

export type TerminalOutputMetadata =
	| Readonly<{ _tag: "data"; sequence: number }>
	| Readonly<{
			_tag: "exit";
			sequence: number;
			exitCode: number | null;
			signal: number | null;
	  }>
	| Readonly<{ _tag: "cursor"; sequence: number }>
	| Readonly<{
			_tag: "gap";
			requestedAfter: number;
			earliestAvailable: number;
			latestAvailable: number;
	  }>;

export type TerminalReduction = Readonly<{
	kind: "accepted" | "duplicate" | "recover" | "failed";
	state: TerminalResourceState;
}>;

export const terminalProcessEpoch = (terminalId: PtyId): string =>
	`pty:${terminalId}`;

export const initialTerminalResourceState = (
	terminalId: PtyId,
	processEpoch = terminalProcessEpoch(terminalId),
): TerminalResourceState => ({
	terminalId,
	processEpoch,
	phase: "connecting",
	outputSequence: 0,
	exitCode: null,
	signal: null,
	failure: null,
});

export const reconnectTerminalResource = (
	state: TerminalResourceState,
): TerminalResourceState =>
	state.phase === "exited" || state.phase === "failed"
		? state
		: { ...state, phase: "reconnecting" };

/** A remote process restart is an explicit epoch reset, never a cursor rewind. */
export const resetTerminalProcess = (
	state: TerminalResourceState,
	processEpoch: string,
): TerminalResourceState =>
	processEpoch === state.processEpoch
		? state
		: initialTerminalResourceState(state.terminalId, processEpoch);

export const failTerminalResource = (
	state: TerminalResourceState,
	failure: Omit<TerminalFailure, "gap"> & {
		readonly gap?: TerminalReplayGap | null;
	},
): TerminalResourceState => ({
	...state,
	phase: "failed",
	failure: { ...failure, gap: failure.gap ?? null },
});

/**
 * Applies only ordered output metadata. A recover result leaves the cursor
 * unchanged so the driver can resubscribe from the last committed sequence.
 */
export const reduceTerminalOutput = (
	state: TerminalResourceState,
	event: TerminalOutputMetadata,
): TerminalReduction => {
	if (event._tag === "gap") {
		return {
			kind: "failed",
			state: failTerminalResource(state, {
				kind: "replay-gap",
				message: "Terminal output is no longer available from this cursor.",
				gap: {
					requestedAfter: event.requestedAfter,
					earliestAvailable: event.earliestAvailable,
					latestAvailable: event.latestAvailable,
				},
			}),
		};
	}

	if (event.sequence < state.outputSequence) {
		return { kind: "duplicate", state };
	}
	if (event._tag === "cursor") {
		if (event.sequence === state.outputSequence) {
			return {
				kind: "accepted",
				state: { ...state, phase: "running", failure: null },
			};
		}
		return {
			kind: "recover",
			state: reconnectTerminalResource(state),
		};
	}
	if (event.sequence === state.outputSequence) {
		return { kind: "duplicate", state };
	}
	if (event.sequence !== state.outputSequence + 1) {
		return {
			kind: "recover",
			state: reconnectTerminalResource(state),
		};
	}
	if (event._tag === "exit") {
		return {
			kind: "accepted",
			state: {
				...state,
				phase: "exited",
				outputSequence: event.sequence,
				exitCode: event.exitCode,
				signal: event.signal,
				failure: null,
			},
		};
	}
	return {
		kind: "accepted",
		state: { ...state, outputSequence: event.sequence, failure: null },
	};
};
