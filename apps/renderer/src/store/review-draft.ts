import { subscribeRendererAccount } from "../lib/renderer-account.ts";
import { createAtomStore } from "../state/atom-store.ts";

type ReviewDraft = {
	readonly runId: string;
	readonly findingIds: readonly string[];
};
/** Opaque intent only: private evidence is fetched again in the chosen workspace. */
export const useReviewDraftStore = createAtomStore<{
	pending: ReviewDraft | null;
	stage: (intent: ReviewDraft) => void;
	clear: () => void;
}>((set) => ({
	pending: null,
	stage: (pending) => set({ pending }),
	clear: () => set({ pending: null }),
}));
subscribeRendererAccount(() => useReviewDraftStore.getState().clear());
