import { beforeEach, describe, expect, it } from "vitest";

import type { SessionId } from "@zuse/wire";

import type { ChipRange } from "../src/lib/codemirror/composer-chips.ts";
import {
  composerDraftKeyForSession,
  useComposerDraftsStore,
} from "../src/store/composer-drafts.ts";

const firstKey = composerDraftKeyForSession("sess1" as SessionId);
const secondKey = composerDraftKeyForSession("sess2" as SessionId);

describe("composer drafts store", () => {
  beforeEach(() => {
    useComposerDraftsStore.setState({ draftsByKey: {} });
  });

  it("saves independent drafts by key", () => {
    useComposerDraftsStore.getState().save(firstKey, {
      doc: "draft one",
      chips: [],
    });
    useComposerDraftsStore.getState().save(secondKey, {
      doc: "draft two",
      chips: [],
    });

    expect(useComposerDraftsStore.getState().draftsByKey[firstKey]?.doc).toBe(
      "draft one",
    );
    expect(useComposerDraftsStore.getState().draftsByKey[secondKey]?.doc).toBe(
      "draft two",
    );
  });

  it("clears one draft without affecting another", () => {
    useComposerDraftsStore.getState().save(firstKey, {
      doc: "draft one",
      chips: [],
    });
    useComposerDraftsStore.getState().save(secondKey, {
      doc: "draft two",
      chips: [],
    });

    useComposerDraftsStore.getState().clear(firstKey);

    expect(useComposerDraftsStore.getState().draftsByKey[firstKey]).toBe(
      undefined,
    );
    expect(useComposerDraftsStore.getState().draftsByKey[secondKey]?.doc).toBe(
      "draft two",
    );
  });

  it("preserves chip metadata in the saved snapshot", () => {
    const chips: ChipRange[] = [
      {
        from: 0,
        to: 12,
        meta: {
          kind: "file",
          relPath: "src/app.tsx",
          absPath: "/repo/src/app.tsx",
          entryKind: "file",
        },
      },
      {
        from: 13,
        to: 26,
        meta: {
          kind: "skill",
          name: "review",
          scope: "project",
        },
      },
    ];

    useComposerDraftsStore.getState().save(firstKey, {
      doc: "@src/app.tsx /review",
      chips,
    });

    expect(useComposerDraftsStore.getState().draftsByKey[firstKey]?.chips).toEqual(
      chips,
    );
  });

  it("removes empty snapshots", () => {
    useComposerDraftsStore.getState().save(firstKey, {
      doc: "draft",
      chips: [],
    });

    useComposerDraftsStore.getState().save(firstKey, {
      doc: "",
      chips: [],
    });

    expect(useComposerDraftsStore.getState().draftsByKey[firstKey]).toBe(
      undefined,
    );
  });
});
