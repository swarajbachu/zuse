import { uploadAttachmentInChunks } from "@zuse/client-runtime/attachment-upload";
import type { SessionRef } from "@zuse/client-runtime/resource-ref";
import {
	type AttachmentRef,
	type AttachmentUploadResult,
	CommandId,
	MAX_ATTACHMENT_BYTES,
} from "@zuse/contracts";
import { useEffect, useState, useSyncExternalStore } from "react";
import { downloadBlob } from "./download-blob.ts";
import { subscribeRendererAccount } from "./renderer-account.ts";
import { dispatchSessionWorkspaceCommand } from "./session-timeline-client-bus.ts";

/** Downloads are intentionally uncached: each request rechecks session authority. */
export const downloadAttachment = async (
	ref: SessionRef,
	id: string,
	signal: AbortSignal,
): Promise<void> => {
	signal.throwIfAborted();
	const epoch = previewEpoch;
	const attachment = await readAttachment(ref, id);
	signal.throwIfAborted();
	assertPreviewEpoch(epoch);
	downloadBlob(
		new Blob([new Uint8Array(attachment.bytes)], { type: attachment.mimeType }),
		attachment.originalName,
	);
};

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
	const epoch = previewEpoch;
	const dispatchUpload = async (
		kind: "attachments.upload" | "attachments.uploadChunk",
		payload: unknown,
	) =>
		(
			await dispatchSessionWorkspaceCommand({
				ref,
				kind,
				commandId: CommandId.make(
					`attachment-upload:${ref.sessionId}:${crypto.randomUUID()}`,
				),
				payload,
			})
		).result;
	const result = await uploadAttachmentInChunks(
		{ ...input, sessionId: ref.sessionId },
		{
			upload: async (payload) =>
				(await dispatchUpload(
					"attachments.upload",
					payload,
				)) as AttachmentUploadResult,
			uploadChunk: async (payload) =>
				(await dispatchUpload(
					"attachments.uploadChunk",
					payload,
				)) as AttachmentUploadResult | null,
		},
	);
	if (epoch === previewEpoch && result.mimeType.startsWith("image/")) {
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
	if (file.size > MAX_ATTACHMENT_BYTES) {
		throw new Error("File too large (max 100 MB)");
	}
	return uploadAttachmentBytes(ref, {
		bytes: await fileToBytes(file),
		mimeType: file.type || "application/octet-stream",
		originalName: file.name || "image",
		...(rootPath ? { rootPath } : {}),
	});
};

/** Read an attachment's bytes back from the environment that stores it. */
const readAttachment = async (
	ref: SessionRef,
	id: string,
): Promise<
	Readonly<{ bytes: Uint8Array; mimeType: string; originalName: string }>
> =>
	(
		await dispatchSessionWorkspaceCommand({
			ref,
			kind: "attachments.read",
			commandId: CommandId.make(
				`attachment-read:${ref.sessionId}:${crypto.randomUUID()}`,
			),
			payload: { sessionId: ref.sessionId, id },
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
let previewEpoch = 0;
const previewListeners = new Set<() => void>();
const subscribePreviewEpoch = (listener: () => void) => {
	previewListeners.add(listener);
	return () => {
		previewListeners.delete(listener);
	};
};
const getPreviewEpoch = () => previewEpoch;
const assertPreviewEpoch = (epoch: number): void => {
	if (epoch !== previewEpoch)
		throw new DOMException("Attachment access changed", "AbortError");
};

const unsubscribeAccount = subscribeRendererAccount(() => {
	previewEpoch += 1;
	previewCache.clear();
	previewRequests.clear();
	previewCacheChars = 0;
	for (const listener of previewListeners) listener();
});
if (import.meta.hot) import.meta.hot.dispose(unsubscribeAccount);

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
	const key = previewKey(ref, id);
	const epoch = previewEpoch;
	const cached = previewCache.get(key);
	if (cached !== undefined) return Promise.resolve(cached);
	const pending = previewRequests.get(key);
	if (pending !== undefined) return pending;
	const request = readAttachment(ref, id)
		.then((attachment) => {
			assertPreviewEpoch(epoch);
			const src = attachmentDataUrl(attachment.bytes, attachment.mimeType);
			cacheAttachmentPreview(ref, id, src);
			return src;
		})
		.finally(() => {
			if (previewRequests.get(key) === request) previewRequests.delete(key);
		});
	previewRequests.set(key, request);
	return request;
};

export const useAttachmentUrl = (ref: SessionRef | null, id: string) => {
	const epoch = useSyncExternalStore(
		subscribePreviewEpoch,
		getPreviewEpoch,
		getPreviewEpoch,
	);
	const [attempt, setAttempt] = useState(0);
	const environmentId = ref?.environmentId;
	const sessionId = ref?.sessionId;
	const [preview, setPreview] = useState<{
		key: string;
		src: string | null;
		failed: boolean;
	} | null>(null);
	const key = JSON.stringify([environmentId, sessionId, id, attempt, epoch]);
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
