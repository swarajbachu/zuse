import type { AttachmentRef, ComposerInput, FileRef } from "@zuse/wire";

export interface PendingDraftAttachment {
  readonly tempId: string;
  readonly file: File;
  readonly previewUrl: string;
}

export interface PendingDraftContextFile {
  readonly tempRelPath: string;
  readonly text: string;
  readonly ext: string;
}

export type UploadDraftAttachment = (
  pending: PendingDraftAttachment,
) => Promise<AttachmentRef>;

export type SaveDraftContextFile = (
  pending: PendingDraftContextFile,
) => Promise<Pick<FileRef, "relPath" | "absPath">>;

export const hasPendingAttachmentIds = (input: ComposerInput): boolean =>
  input.attachments.some((attachment) => attachment.id.startsWith("pending-"));

export const finalizeDraftAttachments = async (
  input: ComposerInput,
  pending: ReadonlyArray<PendingDraftAttachment>,
  upload: UploadDraftAttachment,
): Promise<ComposerInput> => {
  if (pending.length === 0 && !hasPendingAttachmentIds(input)) return input;

  const byTempId = new Map(pending.map((item) => [item.tempId, item]));
  const resolved = new Map<string, AttachmentRef>();
  const attachments: AttachmentRef[] = [];

  for (const attachment of input.attachments) {
    const pendingItem = byTempId.get(attachment.id);
    if (pendingItem === undefined) {
      if (attachment.id.startsWith("pending-")) {
        throw new Error(`Missing pending attachment file for ${attachment.id}`);
      }
      attachments.push(attachment);
      continue;
    }
    const cached = resolved.get(attachment.id);
    if (cached !== undefined) {
      attachments.push(cached);
      continue;
    }
    const ref = await upload(pendingItem);
    resolved.set(attachment.id, ref);
    attachments.push(ref);
  }

  return { ...input, attachments };
};

const isPendingContextRelPath = (relPath: string): boolean =>
  relPath.startsWith(".context/files/paste-pending-");

export const hasPendingContextFileRefs = (input: ComposerInput): boolean =>
  input.fileRefs.some((ref) => isPendingContextRelPath(ref.relPath));

export const finalizeDraftContextFiles = async (
  input: ComposerInput,
  pending: ReadonlyArray<PendingDraftContextFile>,
  save: SaveDraftContextFile,
): Promise<ComposerInput> => {
  if (pending.length === 0 && !hasPendingContextFileRefs(input)) return input;

  const byRelPath = new Map(pending.map((item) => [item.tempRelPath, item]));
  const resolved = new Map<string, Pick<FileRef, "relPath" | "absPath">>();
  const fileRefs: FileRef[] = [];
  let text = input.text;

  for (const ref of input.fileRefs) {
    const pendingItem = byRelPath.get(ref.relPath);
    if (pendingItem === undefined) {
      if (isPendingContextRelPath(ref.relPath)) {
        throw new Error(`Missing pending context file text for ${ref.relPath}`);
      }
      fileRefs.push(ref);
      continue;
    }
    const cached = resolved.get(ref.relPath);
    const saved = cached ?? (await save(pendingItem));
    resolved.set(ref.relPath, saved);
    text = text.replaceAll(`@${ref.relPath}`, `@${saved.relPath}`);
    fileRefs.push({
      relPath: saved.relPath,
      absPath: saved.absPath,
      kind: ref.kind,
    });
  }

  return { ...input, text, fileRefs };
};
