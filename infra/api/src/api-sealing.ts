import { Effect, Redacted, Schema } from "effect";
import {
	type AesGcmEnvelope,
	decryptAesGcmEnvelope,
	encryptAesGcmEnvelope,
	importAesGcmKey,
	importHmacSha256Key,
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

const importedSealingKeys = new WeakMap<
	Redacted.Redacted<string>,
	Promise<CryptoKey>
>();
const importedDigestKeys = new WeakMap<
	Redacted.Redacted<string>,
	Promise<CryptoKey>
>();

const importSealingKey = (
	encodedKey: Redacted.Redacted<string>,
): Promise<CryptoKey> => {
	const cached = importedSealingKeys.get(encodedKey);
	if (cached !== undefined) return cached;
	const pending = importAesGcmKey(Redacted.value(encodedKey)).catch((error) => {
		if (importedSealingKeys.get(encodedKey) === pending)
			importedSealingKeys.delete(encodedKey);
		throw error;
	});
	importedSealingKeys.set(encodedKey, pending);
	return pending;
};

const sealingKey = Effect.gen(function* () {
	const config = yield* ApiConfiguration;
	const encodedKey = config.cloudDataEncryptionKey;
	if (encodedKey === undefined)
		return yield* Effect.fail(
			serviceUnavailable("api_content_encryption_not_configured"),
		);
	return yield* Effect.tryPromise({
		try: () => importSealingKey(encodedKey),
		catch: () => serviceUnavailable("api_content_key_invalid"),
	});
});

const digestKey = Effect.gen(function* () {
	const config = yield* ApiConfiguration;
	const encodedKey = config.cloudDataEncryptionKey;
	if (encodedKey === undefined)
		return yield* Effect.fail(
			serviceUnavailable("api_content_encryption_not_configured"),
		);
	let pending = importedDigestKeys.get(encodedKey);
	if (pending === undefined) {
		pending = importHmacSha256Key(Redacted.value(encodedKey)).catch((error) => {
			if (importedDigestKeys.get(encodedKey) === pending)
				importedDigestKeys.delete(encodedKey);
			throw error;
		});
		importedDigestKeys.set(encodedKey, pending);
	}
	return yield* Effect.tryPromise({
		try: () => pending,
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

const legacyApiMessageSealContext = (
	accountId: string,
	workspaceId: string,
): string => `message\n${accountId}\n${workspaceId}`;

/**
 * Open a conversation-ledger row written either before or after message-level
 * AAD binding was introduced. New writes always use `apiMessageSealContext`;
 * the legacy workspace-bound context is a read-only rollout fallback for rows
 * already persisted by migration 0016.
 */
export const openApiMessageString = (
	accountId: string,
	workspaceId: string,
	messageId: string,
	ciphertext: string,
): Effect.Effect<string, ApiError, ApiConfiguration> =>
	openApiString(
		apiMessageSealContext(accountId, workspaceId, messageId),
		ciphertext,
	).pipe(
		Effect.catch((error: ApiError) =>
			error.code === "api_content_open_failed"
				? openApiString(
						legacyApiMessageSealContext(accountId, workspaceId),
						ciphertext,
					)
				: Effect.fail(error),
		),
	);

/** Keyed, non-reversible fingerprint used by compact idempotency receipts. */
export const digestApiString = (
	context: string,
	plaintext: string,
): Effect.Effect<string, ApiError, ApiConfiguration> =>
	Effect.gen(function* () {
		const key = yield* digestKey;
		return yield* Effect.tryPromise({
			try: async () => {
				const signature = await crypto.subtle.sign(
					"HMAC",
					key,
					new TextEncoder().encode(
						`zuse-cloud-api-digest-v1\n${context}\n${plaintext}`,
					),
				);
				return [...new Uint8Array(signature)]
					.map((byte) => byte.toString(16).padStart(2, "0"))
					.join("");
			},
			catch: () => serviceUnavailable("api_content_digest_failed"),
		});
	});

export const apiMessageSealContext = (
	accountId: string,
	workspaceId: string,
	messageId: string,
): string => `message\n${accountId}\n${workspaceId}\n${messageId}`;

export const apiWebhookSecretSealContext = (
	accountId: string,
	webhookId: string,
): string => `webhook-secret\n${accountId}\n${webhookId}`;

export const apiWebhookPayloadSealContext = (
	accountId: string,
	eventId: string,
): string => `webhook-payload\n${accountId}\n${eventId}`;

export const apiTurnReceiptDigestContext = (
	accountId: string,
	workspaceId: string,
	turnId: string,
): string => `turn-receipt\n${accountId}\n${workspaceId}\n${turnId}`;
