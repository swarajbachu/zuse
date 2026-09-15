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
	| Readonly<{ _tag: "data"; processEpoch?: string; sequence: number }>
	| Readonly<{
			_tag: "exit";
			processEpoch?: string;
			sequence: number;
			exitCode: number | null;
			signal: number | null;
	  }>
	| Readonly<{ _tag: "cursor"; processEpoch?: string; sequence: number }>
	| Readonly<{ _tag: "epoch"; processEpoch: string; sequence: 0 }>
	| Readonly<{
			_tag: "gap";
			processEpoch?: string;
			requestedAfter: number;
			earliestAvailable: number;
			latestAvailable: number;
	  }>;

export type TerminalReduction = Readonly<{
	kind: "accepted" | "duplicate" | "recover" | "failed";
	state: TerminalResourceState;
	resetEpoch?: true;
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
 * Applies only ordered output metadata. Within one process epoch, recovery
 * preserves the cursor; a replacement epoch resets to zero before reduction.
 */
export const reduceTerminalOutput = (
	state: TerminalResourceState,
	event: TerminalOutputMetadata,
): TerminalReduction => {
	const incomingEpoch = event.processEpoch;
	const epochChanged =
		incomingEpoch !== undefined && incomingEpoch !== state.processEpoch;
	const current = epochChanged
		? resetTerminalProcess(state, incomingEpoch)
		: state;
	const result = (reduction: TerminalReduction): TerminalReduction =>
		epochChanged ? { ...reduction, resetEpoch: true } : reduction;

	if (event._tag === "epoch") {
		return epochChanged
			? { kind: "accepted", state: current, resetEpoch: true }
			: { kind: "duplicate", state };
	}
	if (event._tag === "gap") {
		return result({
			kind: "failed",
			state: failTerminalResource(current, {
				kind: "replay-gap",
				message: "Terminal output is no longer available from this cursor.",
				gap: {
					requestedAfter: event.requestedAfter,
					earliestAvailable: event.earliestAvailable,
					latestAvailable: event.latestAvailable,
				},
			}),
		});
	}

	if (event.sequence < current.outputSequence) {
		return result({ kind: "duplicate", state: current });
	}
	if (event._tag === "cursor") {
		if (event.sequence === current.outputSequence) {
			return result({
				kind: "accepted",
				state: { ...current, phase: "running", failure: null },
			});
		}
		return result({
			kind: "recover",
			state: reconnectTerminalResource(current),
		});
	}
	if (event.sequence === current.outputSequence) {
		return result({ kind: "duplicate", state: current });
	}
	if (event.sequence !== current.outputSequence + 1) {
		return result({
			kind: "recover",
			state: reconnectTerminalResource(current),
		});
	}
	if (event._tag === "exit") {
		return result({
			kind: "accepted",
			state: {
				...current,
				phase: "exited",
				outputSequence: event.sequence,
				exitCode: event.exitCode,
				signal: event.signal,
				failure: null,
			},
		});
	}
	return result({
		kind: "accepted",
		state: { ...current, outputSequence: event.sequence, failure: null },
	});
};
