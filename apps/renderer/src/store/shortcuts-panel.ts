import { createAtomStore } from "../state/atom-store.ts";

/** The keyboard shortcuts panel, opened by `?` in an empty composer or Cmd+/. */
export const useShortcutsPanel = createAtomStore<{
	readonly open: boolean;
	readonly setOpen: (open: boolean) => void;
}>((set) => ({
	open: false,
	setOpen: (open) => set({ open }),
}));
