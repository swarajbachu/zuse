import {
	CLOUD_TRANSCRIPT_CHECKPOINT_SCHEMA_VERSION,
	type CloudTranscriptCheckpointAccess,
	CloudTranscriptCheckpointPayload,
	CloudTranscriptMessagePagePayload,
	type CloudTranscriptMessagePageResult,
	type SessionStreamCursor,
} from "@zuse/contracts";
import {
	cloudTranscriptAdditionalData,
	decryptCloudTranscript,
	sha256Base64Url,
} from "@zuse/utils/cloud-transcript-crypto";
import { Schema } from "effect";
import type { SessionRef } from "./resource-ref.ts";

/** Shared authenticated decoding for desktop and mobile cold transcript reads. */
export const openCloudTranscriptCheckpoint = async (
	ref: SessionRef,
	checkpoint: CloudTranscriptCheckpointAccess,
) => {
	if (
		checkpoint.metadata.workspaceId !== ref.environmentId ||
		checkpoint.metadata.sessionId !== ref.sessionId ||
		(await sha256Base64Url(checkpoint.ciphertext)) !==
			checkpoint.metadata.ciphertextSha256
	)
		throw new Error("Cloud transcript checkpoint failed integrity checks");
	const { cursor } = checkpoint.metadata;
	const plaintext = await decryptCloudTranscript({
		encodedKey: checkpoint.transcriptKey,
		additionalData: cloudTranscriptAdditionalData({
			workspaceId: ref.environmentId,
			sessionId: ref.sessionId,
			epoch: cursor.epoch,
			version: cursor.version,
			schemaVersion: CLOUD_TRANSCRIPT_CHECKPOINT_SCHEMA_VERSION,
		}),
		ciphertext: checkpoint.ciphertext,
	});
	const payload = Schema.decodeUnknownSync(CloudTranscriptCheckpointPayload)(
		JSON.parse(new TextDecoder().decode(plaintext)),
	);
	if (
		payload.workspaceId !== ref.environmentId ||
		payload.sessionId !== ref.sessionId ||
		payload.cursor.epoch !== cursor.epoch ||
		payload.cursor.version !== cursor.version
	)
		throw new Error("Cloud transcript checkpoint metadata mismatch");
	return payload;
};

export const openCloudTranscriptPage = async (
	ref: SessionRef,
	cursor: SessionStreamCursor,
	beforeSequence: number,
	encrypted: NonNullable<CloudTranscriptMessagePageResult["page"]>,
) => {
	if (
		encrypted.beforeSequence !== beforeSequence ||
		encrypted.cursor.epoch !== cursor.epoch ||
		encrypted.cursor.version !== cursor.version ||
		(await sha256Base64Url(encrypted.ciphertext)) !== encrypted.ciphertextSha256
	)
		throw new Error("Cloud transcript page failed integrity checks");
	const plaintext = await decryptCloudTranscript({
		encodedKey: encrypted.transcriptKey,
		additionalData: cloudTranscriptAdditionalData({
			workspaceId: ref.environmentId,
			sessionId: ref.sessionId,
			epoch: cursor.epoch,
			version: cursor.version,
			schemaVersion: CLOUD_TRANSCRIPT_CHECKPOINT_SCHEMA_VERSION,
			pageBeforeSequence: beforeSequence,
		}),
		ciphertext: encrypted.ciphertext,
	});
	const page = Schema.decodeUnknownSync(CloudTranscriptMessagePagePayload)(
		JSON.parse(new TextDecoder().decode(plaintext)),
	);
	if (
		page.workspaceId !== ref.environmentId ||
		page.sessionId !== ref.sessionId ||
		page.beforeSequence !== beforeSequence ||
		page.cursor.epoch !== cursor.epoch ||
		page.cursor.version !== cursor.version
	)
		throw new Error("Cloud transcript page belongs to another resource");
	return {
		messages: page.messages,
		olderMessageSequence: page.olderMessageSequence,
	};
};
