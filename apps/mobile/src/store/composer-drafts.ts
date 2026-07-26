import type { FileRef, SkillRef } from "@zuse/contracts";
import { Atom } from "effect/unstable/reactivity";

import * as FileSystem from "expo-file-system/legacy";

import {
	deleteProtectedComposerAttachment,
	type LocalComposerAttachment,
} from "~/lib/composer-attachment-storage";

import { appAtomRegistry } from "./registry";

export type ComposerDraft = {
	text: string;
	attachments: readonly LocalComposerAttachment[];
	goalMode: boolean;
	fileRefs?: readonly FileRef[];
	skillRefs?: readonly SkillRef[];
};

const EMPTY_DRAFT: ComposerDraft = {
	text: "",
	attachments: [],
	goalMode: false,
};

const DRAFT_ROOT = `${FileSystem.documentDirectory ?? ""}zuse-composer-drafts`;
const safeKey = (key: string): string =>
	encodeURIComponent(key).replace(/%/g, "_").slice(0, 220);
const draftPath = (key: string): string => `${DRAFT_ROOT}/${safeKey(key)}.json`;

const persistDraft = async (
	key: string,
	draft: ComposerDraft,
): Promise<void> => {
	await FileSystem.makeDirectoryAsync(DRAFT_ROOT, { intermediates: true });
	await FileSystem.writeAsStringAsync(draftPath(key), JSON.stringify(draft));
};

export const hydrateComposerDraft = async (
	key: string,
): Promise<ComposerDraft | null> => {
	if (appAtomRegistry.get(draftsBySessionAtom)[key] !== undefined)
		return appAtomRegistry.get(draftsBySessionAtom)[key] ?? null;
	try {
		const info = await FileSystem.getInfoAsync(draftPath(key));
		if (!info.exists) return null;
		const parsed = JSON.parse(
			await FileSystem.readAsStringAsync(draftPath(key)),
		) as ComposerDraft;
		if (
			typeof parsed.text !== "string" ||
			!Array.isArray(parsed.attachments) ||
			typeof parsed.goalMode !== "boolean"
		)
			return null;
		appAtomRegistry.update(draftsBySessionAtom, (drafts) => ({
			...drafts,
			[key]: parsed,
		}));
		return parsed;
	} catch {
		await FileSystem.deleteAsync(draftPath(key), { idempotent: true });
		return null;
	}
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
	const previous = appAtomRegistry.get(draftsBySessionAtom)[key];
	appAtomRegistry.update(draftsBySessionAtom, (drafts) => ({
		...drafts,
		[key]: draft,
	}));
	const retained = new Set(draft.attachments.map((item) => item.uri));
	for (const attachment of previous?.attachments ?? []) {
		if (!retained.has(attachment.uri))
			void deleteProtectedComposerAttachment(attachment.uri);
	}
	void persistDraft(key, draft);
};

export const clearComposerDraft = (key: string): void => {
	const previous = appAtomRegistry.get(draftsBySessionAtom)[key];
	appAtomRegistry.update(draftsBySessionAtom, (drafts) => {
		if (!(key in drafts)) return drafts;
		const next = { ...drafts };
		delete next[key];
		return next;
	});
	for (const attachment of previous?.attachments ?? [])
		void deleteProtectedComposerAttachment(attachment.uri);
	void FileSystem.deleteAsync(draftPath(key), { idempotent: true });
};
