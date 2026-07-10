import { describe, expect, it } from "vitest";
import { Schema } from "effect";

import { ComposerInput, type AttachmentRef } from "@zuse/wire";

import {
  appendContextFileRef,
  finalizeDraftAttachments,
  finalizeDraftContextFiles,
  hasPendingAttachmentIds,
  hasPendingContextFileRefs,
  type PendingDraftAttachment,
} from "../src/composer/draft-attachments.ts";

const makeFile = (name: string): File =>
  new File([new Uint8Array([1, 2, 3])], name, { type: "image/png" });

describe("draft attachment finalization", () => {
  it("preserves ComposerInput when appending an issue context file", () => {
    const input = ComposerInput.make({
      text: "inspect this issue",
      attachments: [],
      fileRefs: [],
      skillRefs: [],
    });

    const finalized = appendContextFileRef(input, {
      relPath: ".context/files/issue.md",
      absPath: "/worktree/.context/files/issue.md",
    });

    expect(finalized.fileRefs).toEqual([
      {
        relPath: ".context/files/issue.md",
        absPath: "/worktree/.context/files/issue.md",
        kind: "file",
      },
    ]);
    expect(() => Schema.validateSync(ComposerInput)(finalized)).not.toThrow();
  });

  it("replaces pending attachment ids with uploaded refs", async () => {
    const input = ComposerInput.make({
      text: "inspect this",
      attachments: [
        {
          id: "pending-a",
          mimeType: "image/png",
          originalName: "before.png",
        },
      ],
      fileRefs: [],
      skillRefs: [],
    });
    const pending: PendingDraftAttachment = {
      tempId: "pending-a",
      file: makeFile("before.png"),
      previewUrl: "blob:test",
    };
    const uploaded: AttachmentRef = {
      id: "session-1-real",
      mimeType: "image/png",
      originalName: "before.png",
    };

    const finalized = await finalizeDraftAttachments(input, [pending], () =>
      Promise.resolve(uploaded),
    );

    expect(finalized.attachments).toEqual([uploaded]);
    expect(hasPendingAttachmentIds(finalized)).toBe(false);
    expect(() => Schema.validateSync(ComposerInput)(finalized)).not.toThrow();
  });

  it("throws instead of letting a stale pending id through", async () => {
    const input = ComposerInput.make({
      text: "inspect this",
      attachments: [
        {
          id: "pending-stale",
          mimeType: "image/png",
          originalName: "stale.png",
        },
      ],
      fileRefs: [],
      skillRefs: [],
    });

    await expect(
      finalizeDraftAttachments(input, [], () => {
        throw new Error("should not upload");
      }),
    ).rejects.toThrow("Missing pending attachment file");
  });

  it("replaces pending context file refs and text mentions", async () => {
    const input = ComposerInput.make({
      text: "read @.context/files/paste-pending-abc123.md",
      attachments: [],
      fileRefs: [
        {
          relPath: ".context/files/paste-pending-abc123.md",
          absPath: ".context/files/paste-pending-abc123.md",
          kind: "file",
        },
      ],
      skillRefs: [],
    });

    const finalized = await finalizeDraftContextFiles(
      input,
      [
        {
          tempRelPath: ".context/files/paste-pending-abc123.md",
          text: "large paste",
          ext: "md",
        },
      ],
      () =>
        Promise.resolve({
          relPath: ".context/files/paste-real.md",
          absPath: "/worktree/.context/files/paste-real.md",
        }),
    );

    expect(finalized.text).toBe("read @.context/files/paste-real.md");
    expect(finalized.fileRefs).toEqual([
      {
        relPath: ".context/files/paste-real.md",
        absPath: "/worktree/.context/files/paste-real.md",
        kind: "file",
      },
    ]);
    expect(hasPendingContextFileRefs(finalized)).toBe(false);
    expect(() => Schema.validateSync(ComposerInput)(finalized)).not.toThrow();
  });
});
