import { Atom } from "effect/unstable/reactivity";

import type { LocalComposerAttachment } from "~/lib/composer-attachments";

import { appAtomRegistry } from "./registry";

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

export const draftsBySessionAtom = Atom.make<
	Readonly<Record<string, ComposerDraft>>
>({}).pipe(Atom.keepAlive);

/** Per-session draft; notifies only when this session's draft changes. */
export const composerDraftAtom = Atom.family((key: string) =>
	Atom.make((get) => get(draftsBySessionAtom)[key] ?? EMPTY_DRAFT),
);

export const composerDraft = (key: string): ComposerDraft =>
	appAtomRegistry.get(draftsBySessionAtom)[key] ?? EMPTY_DRAFT;

export const setComposerDraft = (key: string, draft: ComposerDraft): void => {
	appAtomRegistry.update(draftsBySessionAtom, (drafts) => ({
		...drafts,
		[key]: draft,
	}));
};

export const clearComposerDraft = (key: string): void => {
	appAtomRegistry.update(draftsBySessionAtom, (drafts) => {
		if (!(key in drafts)) return drafts;
		const next = { ...drafts };
		delete next[key];
		return next;
	});
};
