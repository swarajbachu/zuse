import type { ThreadScrollMode } from "./thread-scroll";

export type ThreadViewState = {
	mode: Exclude<ThreadScrollMode, "initial">;
	offsetY: number;
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
