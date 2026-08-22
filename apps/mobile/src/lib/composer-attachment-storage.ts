import * as FileSystem from "expo-file-system/legacy";

export type LocalComposerAttachment = {
	id: string;
	uri: string;
	name: string;
	mimeType: string;
	size?: number;
};

const PROTECTED_MEDIA_ROOT = `${FileSystem.documentDirectory ?? ""}zuse-outbox-media`;

const safeName = (value: string): string =>
	value.replace(/[^a-zA-Z0-9._-]/gu, "_").slice(-120) || "attachment";

export const protectComposerAttachment = async (
	attachment: LocalComposerAttachment,
): Promise<LocalComposerAttachment> => {
	await FileSystem.makeDirectoryAsync(PROTECTED_MEDIA_ROOT, {
		intermediates: true,
	});
	const uri = `${PROTECTED_MEDIA_ROOT}/${safeName(attachment.id)}-${safeName(attachment.name)}`;
	await FileSystem.copyAsync({ from: attachment.uri, to: uri });
	return { ...attachment, uri };
};

export const isProtectedComposerAttachment = (uri: string): boolean =>
	uri.startsWith(`${PROTECTED_MEDIA_ROOT}/`);

export const deleteProtectedComposerAttachment = async (
	uri: string,
): Promise<void> => {
	if (!isProtectedComposerAttachment(uri)) return;
	await FileSystem.deleteAsync(uri, { idempotent: true });
};
