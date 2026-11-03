import { createAtomStore as create } from "../state/atom-store.ts";

/**
 * Find-in-chat bar state. The `find-in-chat` command only reveals the bar;
 * the mounted `ChatFindBar` owns matching, highlighting, and scrolling for the
 * active transcript. `revealToken` bumps on every invocation so a repeated
 * Cmd+F re-focuses and re-selects the input while the bar is already open.
 */
type ChatFindState = {
	readonly open: boolean;
	readonly revealToken: number;
	readonly query: string;
	readonly reveal: () => void;
	readonly close: () => void;
	readonly setQuery: (query: string) => void;
};

export const useChatFindStore = create<ChatFindState>((set) => ({
	open: false,
	revealToken: 0,
	query: "",
	reveal: () =>
		set((state) => ({ open: true, revealToken: state.revealToken + 1 })),
	close: () => set((state) => (state.open ? { open: false } : state)),
	setQuery: (query) => set({ query }),
}));
