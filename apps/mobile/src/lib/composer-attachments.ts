import type { AttachmentRef, SessionId } from "@zuse/contracts";
import { Effect } from "effect";
import * as DocumentPicker from "expo-document-picker";
import { File } from "expo-file-system";
import * as ImagePicker from "expo-image-picker";

import { uploadAttachment } from "~/rpc/actions";
import type { WsProtocolOptions } from "~/rpc/ws-protocol";

export type LocalComposerAttachment = {
	id: string;
	uri: string;
	name: string;
	mimeType: string;
	size?: number;
};

const localId = (): string =>
	`local-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

export async function pickComposerImages(): Promise<LocalComposerAttachment[]> {
	const result = await ImagePicker.launchImageLibraryAsync({
		mediaTypes: ["images"],
		allowsMultipleSelection: true,
		quality: 1,
	});
	if (result.canceled) return [];
	return result.assets.map((asset) => ({
		id: localId(),
		uri: asset.uri,
		name: asset.fileName ?? `Photo.${asset.mimeType?.split("/")[1] ?? "jpg"}`,
		mimeType: asset.mimeType ?? "image/jpeg",
		size: asset.fileSize,
	}));
}

export async function pickComposerFiles(): Promise<LocalComposerAttachment[]> {
	const result = await DocumentPicker.getDocumentAsync({
		type: "*/*",
		multiple: true,
		copyToCacheDirectory: true,
	});
	if (result.canceled) return [];
	return result.assets.map((asset) => ({
		id: localId(),
		uri: asset.uri,
		name: asset.name,
		mimeType: asset.mimeType ?? "application/octet-stream",
		size: asset.size,
	}));
}

export async function uploadComposerAttachment(
	connection: WsProtocolOptions,
	sessionId: SessionId,
	attachment: LocalComposerAttachment,
): Promise<AttachmentRef> {
	const bytes = await new File(attachment.uri).bytes();
	return Effect.runPromise(
		uploadAttachment({
			connection,
			sessionId,
			bytes,
			mimeType: attachment.mimeType,
			originalName: attachment.name,
		}),
	);
}
