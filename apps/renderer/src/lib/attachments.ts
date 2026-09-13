import type { SessionRef } from "@zuse/client-runtime/resource-ref";
import { type AttachmentRef, CommandId } from "@zuse/contracts";
import { useEffect, useState } from "react";
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
	if (result.mimeType.startsWith("image/")) {
		cacheAttachmentPreview(
			ref,
			result.id,
			attachmentDataUrl(input.bytes, result.mimeType),
		);
	}
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

/** A portable preview works for sandbox bytes and survives opening another tab. */
export const attachmentDataUrl = (
	bytes: Uint8Array,
	mimeType: string,
): string => {
	let binary = "";
	for (let offset = 0; offset < bytes.length; offset += 32768) {
		binary += String.fromCharCode(...bytes.subarray(offset, offset + 32768));
	}
	return `data:${mimeType};base64,${btoa(binary)}`;
};

const previewCache = new Map<string, string>();
const previewRequests = new Map<string, Promise<string>>();
const MAX_PREVIEW_CACHE_CHARS = 8 * 1024 * 1024;
let previewCacheChars = 0;

const previewKey = (ref: SessionRef, id: string) =>
	JSON.stringify([ref.environmentId, ref.sessionId, id]);

export const cachedAttachmentUrl = (
	ref: SessionRef,
	id: string,
): string | null => previewCache.get(previewKey(ref, id)) ?? null;

export const forgetAttachmentPreview = (ref: SessionRef, id: string): void => {
	const key = previewKey(ref, id);
	previewCacheChars -= previewCache.get(key)?.length ?? 0;
	previewCache.delete(key);
};

export const cacheAttachmentPreview = (
	ref: SessionRef,
	id: string,
	src: string,
): void => {
	const key = previewKey(ref, id);
	if (src.length > MAX_PREVIEW_CACHE_CHARS) return;
	previewCacheChars -= previewCache.get(key)?.length ?? 0;
	previewCache.delete(key);
	while (previewCacheChars + src.length > MAX_PREVIEW_CACHE_CHARS) {
		const oldest = previewCache.keys().next().value;
		if (oldest === undefined) break;
		previewCacheChars -= previewCache.get(oldest)?.length ?? 0;
		previewCache.delete(oldest);
	}
	previewCache.set(key, src);
	previewCacheChars += src.length;
};

export const resolveAttachmentUrl = (
	ref: SessionRef,
	id: string,
): Promise<string> => {
	const key = JSON.stringify([ref.environmentId, ref.sessionId, id]);
	const cached = previewCache.get(key);
	if (cached !== undefined) return Promise.resolve(cached);
	const pending = previewRequests.get(key);
	if (pending !== undefined) return pending;
	const request = readAttachment(ref, id)
		.then((attachment) => {
			const src = attachmentDataUrl(attachment.bytes, attachment.mimeType);
			cacheAttachmentPreview(ref, id, src);
			return src;
		})
		.finally(() => previewRequests.delete(key));
	previewRequests.set(key, request);
	return request;
};

export const useAttachmentUrl = (ref: SessionRef | null, id: string) => {
	const [attempt, setAttempt] = useState(0);
	const environmentId = ref?.environmentId;
	const sessionId = ref?.sessionId;
	const [preview, setPreview] = useState<{
		key: string;
		src: string | null;
		failed: boolean;
	} | null>(null);
	const key = JSON.stringify([environmentId, sessionId, id, attempt]);
	useEffect(() => {
		if (
			environmentId === undefined ||
			sessionId === undefined ||
			id.startsWith("pending-")
		)
			return;
		let cancelled = false;
		void resolveAttachmentUrl({ environmentId, sessionId }, id).then(
			(src) => {
				if (!cancelled) setPreview({ key, src, failed: false });
			},
			() => {
				if (!cancelled) setPreview({ key, src: null, failed: true });
			},
		);
		return () => {
			cancelled = true;
		};
	}, [environmentId, sessionId, id, key]);
	return {
		...(preview?.key === key
			? preview
			: {
					src: ref === null ? null : cachedAttachmentUrl(ref, id),
					failed: false,
				}),
		retry: () => {
			if (ref !== null) forgetAttachmentPreview(ref, id);
			setAttempt((value) => value + 1);
		},
	};
};
