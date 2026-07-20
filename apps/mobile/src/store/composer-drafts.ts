import { create } from "zustand";

import type { LocalComposerAttachment } from "~/lib/composer-attachments";

export type ComposerDraft = {
	text: string;
	attachments: readonly LocalComposerAttachment[];
	goalMode: boolean;
};

const EMPTY_DRAFT: ComposerDraft = {
	text: "",
	attachments: [],
	goalMode: false,
};

type ComposerDraftsState = {
	draftsBySession: Readonly<Record<string, ComposerDraft>>;
	setDraft: (key: string, draft: ComposerDraft) => void;
	clearDraft: (key: string) => void;
};

export const composerDraft = (key: string): ComposerDraft =>
	useComposerDraftsStore.getState().draftsBySession[key] ?? EMPTY_DRAFT;

export const useComposerDraftsStore = create<ComposerDraftsState>((set) => ({
	draftsBySession: {},
	setDraft: (key, draft) =>
		set((state) => ({
			draftsBySession: { ...state.draftsBySession, [key]: draft },
		})),
	clearDraft: (key) =>
		set((state) => {
			if (!(key in state.draftsBySession)) return state;
			const next = { ...state.draftsBySession };
			delete next[key];
			return { draftsBySession: next };
		}),
}));
