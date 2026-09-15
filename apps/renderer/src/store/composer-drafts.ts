import {
	resourceRefKey,
	type SessionRef,
} from "@zuse/client-runtime/resource-ref";
import type { EnvironmentId, FolderId } from "@zuse/contracts";
import type { ChipRange } from "../lib/codemirror/composer-chips.ts";
import { createAtomStore as create } from "../state/atom-store.ts";

export type ComposerDraftSnapshot = {
	readonly doc: string;
	readonly chips: readonly ChipRange[];
};

export type ComposerContext = {
	readonly id: string;
	readonly sourceKey: string;
	readonly label: string;
	readonly text: string;
};
export const EMPTY_COMPOSER_CONTEXTS: readonly ComposerContext[] = [];

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
};

const isEmptySnapshot = (snapshot: ComposerDraftSnapshot): boolean =>
	snapshot.doc.length === 0 && snapshot.chips.length === 0;

export const composerDraftKeyForSession = (ref: SessionRef): string =>
	resourceRefKey(ref);

export const composerDraftKeyForLanding = (
	environmentId: EnvironmentId,
	folderId: FolderId | null,
): string =>
	`landing:${encodeURIComponent(environmentId)}:${encodeURIComponent(folderId ?? "none")}`;

export const composerDraftKeyForRemoteLanding = composerDraftKeyForLanding;

export const useComposerDraftsStore = create<ComposerDraftsState>((set) => ({
	draftsByKey: {},
	contextsByKey: {},
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
					doc: snapshot.doc,
					chips: snapshot.chips.map((chip) => ({ ...chip })),
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
