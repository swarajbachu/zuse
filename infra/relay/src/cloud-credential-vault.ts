import { Context, Effect, Redacted, Schema } from "effect";
import { RelayConfiguration } from "./config.ts";

export type CloudCredentialPayload = {
	readonly credentialType: "api-key" | "oauth-token" | "repository-token";
	readonly secret: string;
};

export class CloudCredentialVaultError extends Schema.TaggedErrorClass<CloudCredentialVaultError>()(
	"CloudCredentialVaultError",
	{ reason: Schema.String },
) {}

export interface CloudCredentialVaultApi {
	readonly enabled: boolean;
	readonly encrypt: (
		accountId: string,
		kind: string,
		version: number,
		payload: CloudCredentialPayload,
	) => Effect.Effect<string, CloudCredentialVaultError>;
	readonly decrypt: (
		accountId: string,
		kind: string,
		version: number,
		envelope: string,
	) => Effect.Effect<CloudCredentialPayload, CloudCredentialVaultError>;
}

export class CloudCredentialVault extends Context.Service<
	CloudCredentialVault,
	CloudCredentialVaultApi
>()("@zuse/relay/CloudCredentialVault") {}

const bytesToBase64Url = (bytes: Uint8Array): string => {
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary)
		.replaceAll("+", "-")
		.replaceAll("/", "_")
		.replace(/=+$/u, "");
};

const base64UrlToBytes = (value: string): Uint8Array => {
	const padded = value
		.replaceAll("-", "+")
		.replaceAll("_", "/")
		.padEnd(Math.ceil(value.length / 4) * 4, "=");
	const binary = atob(padded);
	return Uint8Array.from(binary, (character) => character.charCodeAt(0));
};

const aad = (accountId: string, kind: string, version: number): Uint8Array =>
	new TextEncoder().encode(
		`zuse-cloud-credential-v1\n${accountId}\n${kind}\n${version}`,
	);
const ownedBuffer = (bytes: Uint8Array): ArrayBuffer =>
	bytes.buffer.slice(
		bytes.byteOffset,
		bytes.byteOffset + bytes.byteLength,
	) as ArrayBuffer;

const Envelope = Schema.Struct({
	version: Schema.Literal(1),
	iv: Schema.String,
	ciphertext: Schema.String,
});

const Payload = Schema.Struct({
	credentialType: Schema.Literals([
		"api-key",
		"oauth-token",
		"repository-token",
	]),
	secret: Schema.String,
});

const failure = (reason: string) => new CloudCredentialVaultError({ reason });

export const CloudCredentialVaultLive = Effect.gen(function* () {
	const config = yield* RelayConfiguration;
	const encodedKey = config.cloudCredentialVaultKey;
	if (encodedKey === undefined) {
		return CloudCredentialVault.of({
			enabled: false,
			encrypt: () => Effect.fail(failure("vault_not_configured")),
			decrypt: () => Effect.fail(failure("vault_not_configured")),
		});
	}
	const keyBytes = yield* Effect.try({
		try: () => base64UrlToBytes(Redacted.value(encodedKey)),
		catch: () => failure("vault_key_invalid"),
	});
	if (keyBytes.byteLength !== 32)
		return yield* Effect.fail(failure("vault_key_invalid"));
	const key = yield* Effect.tryPromise({
		try: () =>
			crypto.subtle.importKey(
				"raw",
				ownedBuffer(keyBytes),
				{ name: "AES-GCM" },
				false,
				["encrypt", "decrypt"],
			),
		catch: () => failure("vault_key_invalid"),
	});
	return CloudCredentialVault.of({
		enabled: true,
		encrypt: (accountId, kind, version, payload) =>
			Effect.tryPromise({
				try: async () => {
					const iv = crypto.getRandomValues(new Uint8Array(12));
					const plaintext = new TextEncoder().encode(
						JSON.stringify(Schema.encodeSync(Payload)(payload)),
					);
					const ciphertext = await crypto.subtle.encrypt(
						{
							name: "AES-GCM",
							iv: ownedBuffer(iv),
							additionalData: ownedBuffer(aad(accountId, kind, version)),
						},
						key,
						ownedBuffer(plaintext),
					);
					return JSON.stringify({
						version: 1,
						iv: bytesToBase64Url(iv),
						ciphertext: bytesToBase64Url(new Uint8Array(ciphertext)),
					});
				},
				catch: () => failure("credential_encrypt_failed"),
			}),
		decrypt: (accountId, kind, version, envelope) =>
			Effect.tryPromise({
				try: async () => {
					const decoded = Schema.decodeUnknownSync(Envelope)(
						JSON.parse(envelope) as unknown,
					);
					const plaintext = await crypto.subtle.decrypt(
						{
							name: "AES-GCM",
							iv: ownedBuffer(base64UrlToBytes(decoded.iv)),
							additionalData: ownedBuffer(aad(accountId, kind, version)),
						},
						key,
						ownedBuffer(base64UrlToBytes(decoded.ciphertext)),
					);
					return Schema.decodeUnknownSync(Payload)(
						JSON.parse(new TextDecoder().decode(plaintext)) as unknown,
					);
				},
				catch: () => failure("credential_decrypt_failed"),
			}),
	});
});
