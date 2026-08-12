import { Context, Effect, Redacted, Schema } from "effect";
import {
	decryptAesGcmEnvelope,
	encryptAesGcmEnvelope,
	importAesGcmKey,
} from "./aes-gcm-envelope.ts";
import { RelayConfiguration } from "./config.ts";

export type CloudChatRecordKind =
	| "workspace-metadata"
	| "command"
	| "runtime-event"
	| "attachment-metadata";

export interface CloudChatCipherContext {
	readonly accountId: string;
	readonly workspaceId: string;
	readonly recordKind: CloudChatRecordKind;
	readonly recordId: string;
	readonly version: number;
}

export class CloudChatCipherError extends Schema.TaggedErrorClass<CloudChatCipherError>()(
	"CloudChatCipherError",
	{ reason: Schema.String },
) {}

export interface CloudChatCipherApi {
	readonly enabled: boolean;
	readonly encrypt: (
		context: CloudChatCipherContext,
		plaintext: string,
	) => Effect.Effect<string, CloudChatCipherError>;
	readonly decrypt: (
		context: CloudChatCipherContext,
		envelope: string,
	) => Effect.Effect<string, CloudChatCipherError>;
}

export class CloudChatCipher extends Context.Service<
	CloudChatCipher,
	CloudChatCipherApi
>()("@zuse/relay/CloudChatCipher") {}

const Envelope = Schema.Struct({
	version: Schema.Literal(1),
	keyId: Schema.String,
	iv: Schema.String,
	ciphertext: Schema.String,
});

const failure = (reason: string) => new CloudChatCipherError({ reason });

const additionalData = (context: CloudChatCipherContext): Uint8Array =>
	new TextEncoder().encode(
		[
			"zuse-cloud-chat-v1",
			context.accountId,
			context.workspaceId,
			context.recordKind,
			context.recordId,
			String(context.version),
		].join("\n"),
	);

export const CloudChatCipherLive = Effect.gen(function* () {
	const config = yield* RelayConfiguration;
	const activeKeyId = config.cloudChatEncryptionActiveKeyId;
	const configuredKeys = config.cloudChatEncryptionKeys;
	if (activeKeyId === undefined || configuredKeys === undefined) {
		return CloudChatCipher.of({
			enabled: false,
			encrypt: () => Effect.fail(failure("chat_encryption_not_configured")),
			decrypt: () => Effect.fail(failure("chat_encryption_not_configured")),
		});
	}

	const keys = new Map<string, CryptoKey>();
	for (const [keyId, encodedKey] of Object.entries(configuredKeys)) {
		const key = yield* Effect.tryPromise({
			try: () => importAesGcmKey(Redacted.value(encodedKey)),
			catch: () => failure("chat_encryption_key_invalid"),
		});
		keys.set(keyId, key);
	}
	const activeKey = keys.get(activeKeyId);
	if (activeKey === undefined)
		return yield* Effect.fail(failure("chat_encryption_active_key_missing"));

	return CloudChatCipher.of({
		enabled: true,
		encrypt: (context, plaintext) =>
			Effect.tryPromise({
				try: () =>
					encryptAesGcmEnvelope({
						key: activeKey,
						keyId: activeKeyId,
						additionalData: additionalData(context),
						plaintext: new TextEncoder().encode(plaintext),
					}),
				catch: () => failure("chat_encrypt_failed"),
			}),
		decrypt: (context, envelope) =>
			Effect.tryPromise({
				try: async () => {
					const decoded = Schema.decodeUnknownSync(Envelope)(
						JSON.parse(envelope) as unknown,
					);
					const key = keys.get(decoded.keyId);
					if (key === undefined) throw new Error("unknown key");
					const plaintext = await decryptAesGcmEnvelope({
						key,
						additionalData: additionalData(context),
						envelope: decoded,
					});
					return new TextDecoder().decode(plaintext);
				},
				catch: () => failure("chat_decrypt_failed"),
			}),
	});
});
