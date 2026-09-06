import type { SessionRef } from "@zuse/client-runtime/resource-ref";
import { type AttachmentRef, CommandId } from "@zuse/contracts";
import { dispatchSessionCommand } from "./session-timeline-client-bus.ts";

/**
 * Per-image cap that mirrors the server-side validator. Rejecting in the
 * renderer first keeps the round-trip toast fast and avoids ever sending
 * gigabytes that would be rejected anyway.
 */
const MAX_IMAGE_BYTES = 100 * 1024 * 1024;

const fileToBytes = (file: File): Promise<Uint8Array> =>
	new Promise((resolve, reject) => {
		const reader = new FileReader();
		reader.onload = () => {
			const buf = reader.result;
			if (buf instanceof ArrayBuffer) resolve(new Uint8Array(buf));
			else reject(new Error("FileReader produced non-ArrayBuffer result"));
		};
		reader.onerror = () =>
			reject(reader.error ?? new Error("FileReader error"));
		reader.readAsArrayBuffer(file);
	});

/**
 * Upload bytes into the session's workspace on the environment that owns it.
 * The environment is explicit because a cloud workspace's session lives on
 * the sandbox, never on the active local environment.
 */
export const uploadAttachmentBytes = async (
	ref: SessionRef,
	input: {
		readonly bytes: Uint8Array;
		readonly mimeType: string;
		readonly originalName: string;
		readonly rootPath?: string;
	},
): Promise<AttachmentRef> => {
	const result = (
		await dispatchSessionCommand({
			ref,
			kind: "attachments.upload",
			commandId: CommandId.make(
				`attachment-upload:${ref.sessionId}:${crypto.randomUUID()}`,
			),
			payload: {
				sessionId: ref.sessionId,
				bytes: input.bytes,
				mimeType: input.mimeType,
				originalName: input.originalName,
				...(input.rootPath ? { rootPath: input.rootPath } : {}),
			},
			retry: "never",
		})
	).result as Readonly<{ id: string; mimeType: string }>;
	return {
		id: result.id,
		mimeType: result.mimeType,
		originalName: input.originalName,
	};
};

export const uploadAttachment = async (
	ref: SessionRef,
	file: File,
	rootPath?: string,
): Promise<AttachmentRef> => {
	if (file.size > MAX_IMAGE_BYTES) {
		throw new Error("Image too large (max 100 MB)");
	}
	return uploadAttachmentBytes(ref, {
		bytes: await fileToBytes(file),
		mimeType: file.type || "application/octet-stream",
		originalName: file.name || "image",
		...(rootPath ? { rootPath } : {}),
	});
};

/** Read an attachment's bytes back from the environment that stores it. */
export const readAttachment = async (
	ref: SessionRef,
	id: string,
): Promise<
	Readonly<{ bytes: Uint8Array; mimeType: string; originalName: string }>
> =>
	(
		await dispatchSessionCommand({
			ref,
			kind: "attachments.read",
			commandId: CommandId.make(
				`attachment-read:${ref.sessionId}:${crypto.randomUUID()}`,
			),
			payload: { sessionId: ref.sessionId, id },
			retry: "never",
		})
	).result as Readonly<{
		bytes: Uint8Array;
		mimeType: string;
		originalName: string;
	}>;
