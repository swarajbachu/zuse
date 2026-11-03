import {
	resourceRefKey,
	type SessionRef,
} from "@zuse/client-runtime/resource-ref";
import type {
	ComposerAnnotation,
	EnvironmentId,
	FolderId,
	WorkspaceScope,
} from "@zuse/contracts";
import type {
	PendingDraftAttachment,
	PendingDraftContextFile,
} from "../composer/draft-attachments.ts";
import type { ChipRange } from "../lib/codemirror/composer-chips.ts";
import { createAtomStore as create } from "../state/atom-store.ts";

export type ComposerDraftSnapshot = {
	readonly annotations?: readonly ComposerAnnotation[];
	readonly doc: string;
	readonly chips: readonly ChipRange[];
	readonly pendingAttachments?: readonly PendingDraftAttachment[];
	readonly pendingContextFiles?: readonly PendingDraftContextFile[];
};

export type ComposerContext = {
	readonly id: string;
	readonly sourceKey: string;
	readonly label: string;
	readonly text: string;
};
export const EMPTY_COMPOSER_CONTEXTS: readonly ComposerContext[] = [];
/** Recover a failed send without replacing text typed while delivery was pending. */
export const recoverComposerDraft = (
	submitted: ComposerDraftSnapshot,
	current?: ComposerDraftSnapshot | null,
): ComposerDraftSnapshot => {
	if (!current || (current.doc.length === 0 && current.chips.length === 0))
		return submitted;
	const prefix = `${submitted.doc}\n\n`;
	return {
		doc: prefix + current.doc,
		pendingAttachments: [
			...(submitted.pendingAttachments ?? []),
			...(current.pendingAttachments ?? []),
		],
		pendingContextFiles: [
			...(submitted.pendingContextFiles ?? []),
			...(current.pendingContextFiles ?? []),
		],
		chips: [
			...submitted.chips,
			...current.chips.map((chip) => ({
				...chip,
				from: chip.from + prefix.length,
				to: chip.to + prefix.length,
			})),
		],
	};
};

type ComposerDraftsState = {
	readonly contextsByKey: Record<string, readonly ComposerContext[]>;
	readonly addContext: (
		key: string,
		context: Omit<ComposerContext, "id">,
	) => void;
	readonly removeContexts: (key: string, ids: readonly string[]) => void;
	readonly draftsByKey: Record<string, ComposerDraftSnapshot>;
	readonly save: (key: string, snapshot: ComposerDraftSnapshot) => void;
	readonly clear: (key: string) => void;
	/** One draft per composer set aside with Ctrl+S. */
	readonly stashesByKey: Record<string, ComposerDraftSnapshot>;
	/** Store `snapshot` as the stash and return the one it replaced. */
	readonly swapStash: (
		key: string,
		snapshot: ComposerDraftSnapshot | null,
	) => ComposerDraftSnapshot | null;
};

const isEmptySnapshot = (snapshot: ComposerDraftSnapshot): boolean =>
	snapshot.doc.length === 0 &&
	snapshot.chips.length === 0 &&
	(snapshot.annotations?.length ?? 0) === 0;

export const composerDraftKeyForSession = (ref: SessionRef): string =>
	resourceRefKey(ref);

export const composerDraftKeyForLanding = (
	environmentId: EnvironmentId,
	folderId: FolderId | null,
	scope: WorkspaceScope = { kind: "personal" },
): string => {
	const key = `landing:${encodeURIComponent(environmentId)}:${encodeURIComponent(folderId ?? "none")}`;
	return scope.kind === "personal"
		? key
		: `organization:${encodeURIComponent(scope.organizationId)}:${key}`;
};

export const composerDraftKeyForNewChat = (
	environmentId: EnvironmentId,
	scope: WorkspaceScope = { kind: "personal" },
): string => composerDraftKeyForLanding(environmentId, null, scope);

export const composerDraftKeyForRemoteLanding = composerDraftKeyForLanding;

export const useComposerDraftsStore = create<ComposerDraftsState>((set) => ({
	draftsByKey: {},
	contextsByKey: {},
	stashesByKey: {},
	swapStash: (key, snapshot) => {
		let previous: ComposerDraftSnapshot | null = null;
		set((state) => {
			previous = state.stashesByKey[key] ?? null;
			const next = { ...state.stashesByKey };
			if (snapshot === null || isEmptySnapshot(snapshot)) delete next[key];
			else next[key] = { doc: snapshot.doc, chips: [...snapshot.chips] };
			return { stashesByKey: next };
		});
		return previous;
	},
	addContext: (key, context) =>
		set((state) => ({
			contextsByKey: {
				...state.contextsByKey,
				[key]: [
					...(state.contextsByKey[key] ?? []).filter(
						(item) => item.sourceKey !== context.sourceKey,
					),
					{ ...context, id: crypto.randomUUID() },
				],
			},
		})),
	removeContexts: (key, ids) =>
		set((state) => {
			const next = { ...state.contextsByKey };
			const remaining = (next[key] ?? []).filter(
				(item) => !ids.includes(item.id),
			);
			if (remaining.length) next[key] = remaining;
			else delete next[key];
			return { contextsByKey: next };
		}),
	save: (key, snapshot) =>
		set((state) => {
			const next = { ...state.draftsByKey };
			if (isEmptySnapshot(snapshot)) {
				delete next[key];
			} else {
				next[key] = {
					annotations: snapshot.annotations,
					doc: snapshot.doc,
					chips: snapshot.chips.map((chip) => ({ ...chip })),
					...(snapshot.pendingAttachments
						? { pendingAttachments: [...snapshot.pendingAttachments] }
						: {}),
					...(snapshot.pendingContextFiles
						? { pendingContextFiles: [...snapshot.pendingContextFiles] }
						: {}),
				};
			}
			return { draftsByKey: next };
		}),
	clear: (key) =>
		set((state) => {
			if (state.draftsByKey[key] === undefined) return state;
			const next = { ...state.draftsByKey };
			delete next[key];
			return { draftsByKey: next };
		}),
}));
