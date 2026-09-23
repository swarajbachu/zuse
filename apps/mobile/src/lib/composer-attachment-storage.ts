import * as FileSystem from "expo-file-system/legacy";

export type LocalComposerAttachment = {
	id: string;
	uri: string;
	name: string;
	mimeType: string;
	size?: number;
};

const PROTECTED_MEDIA_ROOT = `${FileSystem.documentDirectory ?? ""}zuse-outbox-media`;

let generation = 0;
let clearing: Promise<void> | null = null;
const writes = new Set<Promise<LocalComposerAttachment>>();

const safeName = (value: string): string =>
	value.replace(/[^a-zA-Z0-9._-]/gu, "_").slice(-120) || "attachment";

export const protectComposerAttachment = (
	attachment: LocalComposerAttachment,
): Promise<LocalComposerAttachment> => {
	if (clearing)
		return Promise.reject(new Error("Local data is being cleared."));
	const epoch = generation;
	const operation = (async () => {
		await FileSystem.makeDirectoryAsync(PROTECTED_MEDIA_ROOT, {
			intermediates: true,
		});
		const uri = `${PROTECTED_MEDIA_ROOT}/${safeName(attachment.id)}-${safeName(attachment.name)}`;
		await FileSystem.copyAsync({ from: attachment.uri, to: uri });
		if (epoch !== generation)
			throw new Error("Attachment selection was cancelled by a data reset.");
		return { ...attachment, uri };
	})();
	writes.add(operation);
	void operation.finally(() => writes.delete(operation)).catch(() => undefined);
	return operation;
};

export const clearProtectedComposerAttachments = (): Promise<void> => {
	if (clearing) return clearing;
	generation += 1;
	clearing = (async () => {
		await Promise.allSettled([...writes]);
		await FileSystem.deleteAsync(PROTECTED_MEDIA_ROOT, { idempotent: true });
	})().finally(() => {
		clearing = null;
	});
	return clearing;
};

export const isProtectedComposerAttachment = (uri: string): boolean =>
	uri.startsWith(`${PROTECTED_MEDIA_ROOT}/`);

export const deleteProtectedComposerAttachment = async (
	uri: string,
): Promise<void> => {
	if (!isProtectedComposerAttachment(uri)) return;
	await FileSystem.deleteAsync(uri, { idempotent: true });
};
