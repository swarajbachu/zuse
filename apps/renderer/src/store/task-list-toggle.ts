import { createAtomStore } from "../state/atom-store.ts";

/** Bumped by the Ctrl+T shortcut; every visible plan tray flips open/closed. */
export const useTaskListToggle = createAtomStore<{
	readonly epoch: number;
	readonly toggle: () => void;
}>((set) => ({
	epoch: 0,
	toggle: () => set((state) => ({ epoch: state.epoch + 1 })),
}));
