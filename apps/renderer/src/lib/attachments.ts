import {
	type AttachmentRef,
	CommandId,
	EnvironmentId,
	type SessionId,
} from "@zuse/contracts";
import { useEnvironmentCatalogStore } from "../store/environment-catalog.ts";
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

export const uploadAttachment = async (
	sessionId: SessionId,
	file: File,
	rootPath?: string,
): Promise<AttachmentRef> => {
	if (file.size > MAX_IMAGE_BYTES) {
		throw new Error("Image too large (max 100 MB)");
	}
	const environmentId = EnvironmentId.make(
		useEnvironmentCatalogStore.getState().activeEnvironmentId,
	);
	const ref = { environmentId, sessionId };
	const result = (
		await dispatchSessionCommand({
			ref,
			kind: "attachments.upload",
			commandId: CommandId.make(
				`attachment-upload:${sessionId}:${Date.now().toString(36)}`,
			),
			payload: {
				sessionId,
				bytes: await fileToBytes(file),
				mimeType: file.type || "application/octet-stream",
				originalName: file.name || "image",
				...(rootPath ? { rootPath } : {}),
			},
			retry: "never",
		})
	).result as Readonly<{ id: string; mimeType: string }>;
	return {
		id: result.id,
		mimeType: result.mimeType,
		originalName: file.name || "image",
	};
};
