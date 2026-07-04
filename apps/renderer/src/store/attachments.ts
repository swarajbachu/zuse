import { Effect } from "effect";
import { create } from "zustand";

import type { AttachmentRef, SessionId } from "@zuse/wire";

import { getRpcClient } from "../lib/rpc-client.ts";

/**
 * Per-image cap that mirrors the server-side validator. Rejecting in the
 * renderer first keeps the round-trip toast fast and avoids ever sending
 * gigabytes that would be rejected anyway.
 */
const MAX_IMAGE_BYTES = 100 * 1024 * 1024;

type AttachmentsState = {
  readonly uploadOne: (
    sessionId: SessionId,
    file: File,
    rootPath?: string,
  ) => Promise<AttachmentRef>;
};

const fileToBytes = (file: File): Promise<Uint8Array> =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const buf = reader.result;
      if (buf instanceof ArrayBuffer) resolve(new Uint8Array(buf));
      else reject(new Error("FileReader produced non-ArrayBuffer result"));
    };
    reader.onerror = () => reject(reader.error ?? new Error("FileReader error"));
    reader.readAsArrayBuffer(file);
  });

export const useAttachmentsStore = create<AttachmentsState>(() => ({
  uploadOne: async (sessionId, file, rootPath) => {
    if (file.size > MAX_IMAGE_BYTES) {
      throw new Error(`Image too large (max 100 MB)`);
    }
    const bytes = await fileToBytes(file);
    const client = await getRpcClient();
    const result = await Effect.runPromise(
      client.attachments.upload({
        sessionId,
        bytes,
        mimeType: file.type || "application/octet-stream",
        originalName: file.name || "image",
        // `rootPath` is a fallback the server uses only when it can't resolve
        // the session's cwd itself (e.g. a brand-new chat before first send).
        ...(rootPath ? { rootPath } : {}),
      }),
    );
    const ref: AttachmentRef = {
      id: result.id,
      mimeType: result.mimeType,
      originalName: file.name || "image",
    };
    return ref;
  },
}));
