import { createAtomStore as create } from "../state/atom-store.ts";

import type { FolderId, SessionId } from "@zuse/contracts";

import type { ChipRange } from "../lib/codemirror/composer-chips.ts";

export type ComposerDraftSnapshot = {
  readonly doc: string;
  readonly chips: readonly ChipRange[];
};

type ComposerDraftsState = {
  readonly draftsByKey: Record<string, ComposerDraftSnapshot>;
  readonly save: (key: string, snapshot: ComposerDraftSnapshot) => void;
  readonly clear: (key: string) => void;
};

const isEmptySnapshot = (snapshot: ComposerDraftSnapshot): boolean =>
  snapshot.doc.length === 0 && snapshot.chips.length === 0;

export const composerDraftKeyForSession = (sessionId: SessionId): string =>
  `session:${sessionId}`;

export const composerDraftKeyForLanding = (
  folderId: FolderId | null,
): string => `landing:${folderId ?? "none"}`;

export const useComposerDraftsStore = create<ComposerDraftsState>((set) => ({
  draftsByKey: {},
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
