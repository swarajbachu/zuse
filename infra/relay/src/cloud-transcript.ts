import { bytesToBase64Url } from "@zuse/utils/cloud-transcript-crypto";
import { Effect, Redacted, Schema } from "effect";
import {
	decryptAesGcmEnvelope,
	encryptAesGcmEnvelope,
	importAesGcmKey,
} from "./aes-gcm-envelope.ts";
import { RelayConfiguration } from "./config.ts";

export const MAX_CLOUD_TRANSCRIPT_CIPHERTEXT_BYTES = 1024 * 1024;
export const MAX_CLOUD_TRANSCRIPT_PAGE_CIPHERTEXT_BYTES = 4 * 1024 * 1024;

export class CloudTranscriptStoreError extends Schema.TaggedErrorClass<CloudTranscriptStoreError>()(
	"CloudTranscriptStoreError",
	{ reason: Schema.String },
) {}

const fail = (reason: string) => new CloudTranscriptStoreError({ reason });

const TranscriptKeyEnvelope = Schema.Struct({
	version: Schema.Literal(1),
	iv: Schema.String,
	ciphertext: Schema.String,
});

const transcriptKeyAad = (accountId: string, workspaceId: string): Uint8Array =>
	new TextEncoder().encode(
		`zuse-cloud-transcript-wrapping-v1\n${accountId}\n${workspaceId}`,
	);

const wrappingKey = Effect.fn("cloudTranscriptWrappingKey")(function* () {
	const encoded = (yield* RelayConfiguration).cloudCredentialVaultKey;
	if (encoded === undefined)
		return yield* Effect.fail(fail("transcript_key_not_configured"));
	return yield* Effect.tryPromise({
		try: () => importAesGcmKey(Redacted.value(encoded)),
		catch: () => fail("transcript_key_wrapping_key_invalid"),
	});
});

export const createCloudTranscriptKey = Effect.fn("createCloudTranscriptKey")(
	function* (accountId: string, workspaceId: string) {
		const key = bytesToBase64Url(crypto.getRandomValues(new Uint8Array(32)));
		const master = yield* wrappingKey();
		return yield* Effect.tryPromise({
			try: async () => ({
				key,
				envelope: await encryptAesGcmEnvelope({
					key: master,
					additionalData: transcriptKeyAad(accountId, workspaceId),
					plaintext: new TextEncoder().encode(key),
				}),
			}),
			catch: () => fail("transcript_key_wrap_failed"),
		});
	},
);

export const openCloudTranscriptKey = Effect.fn("openCloudTranscriptKey")(
	function* (accountId: string, workspaceId: string, envelope: string) {
		const master = yield* wrappingKey();
		return yield* Effect.tryPromise({
			try: async () => {
				const decoded = Schema.decodeUnknownSync(TranscriptKeyEnvelope)(
					JSON.parse(envelope) as unknown,
				);
				const plaintext = await decryptAesGcmEnvelope({
					key: master,
					additionalData: transcriptKeyAad(accountId, workspaceId),
					envelope: decoded,
				});
				return new TextDecoder().decode(plaintext);
			},
			catch: () => fail("transcript_key_unwrap_failed"),
		});
	},
);

export const cloudTranscriptObjectKey = (input: {
	readonly workspaceId: string;
	readonly sessionId: string;
	readonly runtimeGeneration: number;
	readonly epoch: string;
	readonly version: number;
}): string =>
	`workspaces/${encodeURIComponent(input.workspaceId)}/sessions/${encodeURIComponent(input.sessionId)}/generations/${input.runtimeGeneration}/${encodeURIComponent(input.epoch)}/${input.version}.json`;

export const cloudTranscriptMessagePageObjectKey = (input: {
	readonly workspaceId: string;
	readonly sessionId: string;
	readonly runtimeGeneration: number;
	readonly epoch: string;
	readonly version: number;
	readonly beforeSequence: number;
}): string =>
	`workspaces/${encodeURIComponent(input.workspaceId)}/sessions/${encodeURIComponent(input.sessionId)}/generations/${input.runtimeGeneration}/${encodeURIComponent(input.epoch)}/${input.version}/pages/${input.beforeSequence}.json`;

export const putCloudTranscriptObject = Effect.fn("putCloudTranscriptObject")(
	function* (key: string, ciphertext: string) {
		const objects = (yield* RelayConfiguration).cloudTranscriptObjects;
		if (objects === undefined)
			return yield* Effect.fail(fail("transcript_store_not_configured"));
		return yield* Effect.tryPromise({
			try: async () => {
				const result = await objects.put(key, ciphertext);
				if (result === "exists" && (await objects.get(key)) !== ciphertext) {
					throw new Error("immutable transcript object collision");
				}
			},
			catch: () => fail("transcript_store_write_failed"),
		});
	},
);

export const getCloudTranscriptObject = Effect.fn("getCloudTranscriptObject")(
	function* (key: string) {
		const objects = (yield* RelayConfiguration).cloudTranscriptObjects;
		if (objects === undefined)
			return yield* Effect.fail(fail("transcript_store_not_configured"));
		return yield* Effect.tryPromise({
			try: () => objects.get(key),
			catch: () => fail("transcript_store_read_failed"),
		});
	},
);

export const deleteCloudTranscriptObjects = Effect.fn(
	"deleteCloudTranscriptObjects",
)(function* (workspaceId: string) {
	const objects = (yield* RelayConfiguration).cloudTranscriptObjects;
	if (objects === undefined) return;
	return yield* Effect.tryPromise({
		try: () =>
			objects.deletePrefix(`workspaces/${encodeURIComponent(workspaceId)}/`),
		catch: () => fail("transcript_store_delete_failed"),
	});
});
