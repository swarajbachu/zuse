import type { ThreadScrollMode } from "./thread-scroll";

export type ThreadViewState = {
	mode: Exclude<ThreadScrollMode, "initial">;
	offsetY: number;
	anchorTurnId?: string;
	distanceFromBottom: number;
};

const states = new Map<string, ThreadViewState>();

export const readThreadViewState = (key: string): ThreadViewState | null =>
	states.get(key) ?? null;

export const writeThreadViewState = (
	key: string,
	state: ThreadViewState,
): void => {
	states.set(key, {
		...state,
		offsetY: Math.max(0, state.offsetY),
		distanceFromBottom: Math.max(0, state.distanceFromBottom),
	});
};

/** Resolve by stable turn identity; offsets change when history is prepended. */
export const restoredThreadTurnIndex = (
	state: ThreadViewState | null,
	turns: readonly { readonly id: string }[],
): number =>
	state?.mode === "detached" && state.anchorTurnId !== undefined
		? turns.findIndex((turn) => turn.id === state.anchorTurnId)
		: -1;
