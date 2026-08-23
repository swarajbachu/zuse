import {
	FileRef,
	type FileRef as FileRefValue,
	SkillRef,
	type SkillRef as SkillRefValue,
} from "@zuse/contracts";
import { Effect, Schema } from "effect";
import { Atom } from "effect/unstable/reactivity";

import * as FileSystem from "expo-file-system/legacy";

import {
	deleteProtectedComposerAttachment,
	type LocalComposerAttachment,
} from "~/lib/composer-attachment-storage";
import { deletePath, ensureDir, readJson, writeJson } from "~/offline/cache";

import { appAtomRegistry } from "./registry";

export type ComposerDraft = {
	text: string;
	attachments: readonly LocalComposerAttachment[];
	goalMode: boolean;
	fileRefs?: readonly FileRefValue[];
	skillRefs?: readonly SkillRefValue[];
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
const persistenceTails = new Map<string, Promise<void>>();

const ComposerDraftSchema = Schema.Struct({
	text: Schema.String,
	attachments: Schema.Array(
		Schema.Struct({
			id: Schema.String,
			uri: Schema.String,
			name: Schema.String,
			mimeType: Schema.String,
			size: Schema.optional(Schema.Number),
		}),
	),
	goalMode: Schema.Boolean,
	fileRefs: Schema.optional(Schema.Array(FileRef)),
	skillRefs: Schema.optional(Schema.Array(SkillRef)),
});

const persistDraft = async (
	key: string,
	draft: ComposerDraft,
): Promise<void> => {
	await Effect.runPromise(
		ensureDir(DRAFT_ROOT).pipe(
			Effect.andThen(writeJson(draftPath(key), draft)),
		),
	);
};

const queueDraftOperation = (
	key: string,
	operation: () => Promise<void>,
): void => {
	const previous = persistenceTails.get(key) ?? Promise.resolve();
	const next = previous
		.catch(() => undefined)
		.then(operation)
		.finally(() => {
			if (persistenceTails.get(key) === next) persistenceTails.delete(key);
		});
	persistenceTails.set(key, next);
};

export const hydrateComposerDraft = async (
	key: string,
): Promise<ComposerDraft | null> => {
	if (appAtomRegistry.get(draftsBySessionAtom)[key] !== undefined)
		return appAtomRegistry.get(draftsBySessionAtom)[key] ?? null;
	try {
		const parsed = await Effect.runPromise(
			readJson(draftPath(key), (value) =>
				Schema.decodeUnknownSync(ComposerDraftSchema)(value),
			),
		);
		if (parsed === null) return null;
		appAtomRegistry.update(draftsBySessionAtom, (drafts) => ({
			...drafts,
			[key]: parsed,
		}));
		return parsed;
	} catch {
		await Effect.runPromise(deletePath(draftPath(key))).catch(() => undefined);
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
	queueDraftOperation(key, () => persistDraft(key, draft));
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
	queueDraftOperation(key, () => Effect.runPromise(deletePath(draftPath(key))));
};
