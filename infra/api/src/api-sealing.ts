import { Effect, Redacted, Schema } from "effect";
import {
	type AesGcmEnvelope,
	decryptAesGcmEnvelope,
	encryptAesGcmEnvelope,
	importAesGcmKey,
} from "./aes-gcm-envelope.ts";
import { ApiConfiguration } from "./config.ts";
import { type ApiError, serviceUnavailable } from "./errors.ts";

// Public-API content at rest (conversation-ledger text, webhook payloads and
// signing secrets) is sealed with the API data-encryption key, mirroring the
// launch-intent cipher. `context` binds each ciphertext to its owning row so
// envelopes cannot be replayed across accounts, workspaces, or columns.

const Envelope = Schema.Struct({
	version: Schema.Literal(1),
	iv: Schema.String,
	ciphertext: Schema.String,
});

const aad = (context: string): Uint8Array =>
	new TextEncoder().encode(`zuse-cloud-api-v1\n${context}`);

const sealingKey = Effect.gen(function* () {
	const config = yield* ApiConfiguration;
	const encodedKey = config.cloudDataEncryptionKey;
	if (encodedKey === undefined)
		return yield* Effect.fail(
			serviceUnavailable("api_content_encryption_not_configured"),
		);
	return yield* Effect.tryPromise({
		try: () => importAesGcmKey(Redacted.value(encodedKey)),
		catch: () => serviceUnavailable("api_content_key_invalid"),
	});
});

export const sealApiString = (
	context: string,
	plaintext: string,
): Effect.Effect<string, ApiError, ApiConfiguration> =>
	Effect.gen(function* () {
		const key = yield* sealingKey;
		return yield* Effect.tryPromise({
			try: () =>
				encryptAesGcmEnvelope({
					key,
					additionalData: aad(context),
					plaintext: new TextEncoder().encode(plaintext),
				}),
			catch: () => serviceUnavailable("api_content_seal_failed"),
		});
	});

export const openApiString = (
	context: string,
	ciphertext: string,
): Effect.Effect<string, ApiError, ApiConfiguration> =>
	Effect.gen(function* () {
		const key = yield* sealingKey;
		return yield* Effect.tryPromise({
			try: async () => {
				const envelope: AesGcmEnvelope = Schema.decodeUnknownSync(Envelope)(
					JSON.parse(ciphertext) as unknown,
				);
				const plaintext = await decryptAesGcmEnvelope({
					key,
					additionalData: aad(context),
					envelope,
				});
				return new TextDecoder().decode(plaintext);
			},
			catch: () => serviceUnavailable("api_content_open_failed"),
		});
	});

export const apiMessageSealContext = (
	accountId: string,
	workspaceId: string,
): string => `message\n${accountId}\n${workspaceId}`;

export const apiWebhookSecretSealContext = (
	accountId: string,
	webhookId: string,
): string => `webhook-secret\n${accountId}\n${webhookId}`;

export const apiWebhookPayloadSealContext = (
	accountId: string,
	eventId: string,
): string => `webhook-payload\n${accountId}\n${eventId}`;
