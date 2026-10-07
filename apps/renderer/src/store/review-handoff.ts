import type { ReviewFixLink } from "@zuse/client-runtime/review-links";
import { createAtomStore } from "../state/atom-store.ts";

/** Ephemeral navigation only: never persists findings or starts an agent. */
export const useReviewHandoffStore = createAtomStore<{
	readonly pending: ReviewFixLink | null;
	readonly accept: (link: ReviewFixLink) => void;
	readonly clear: () => void;
}>((set) => ({
	pending: null,
	accept: (pending) => set({ pending }),
	clear: () => set({ pending: null }),
}));
