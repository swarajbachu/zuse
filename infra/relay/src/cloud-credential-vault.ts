import { Context, Effect, Redacted, Schema } from "effect";
import {
	decryptAesGcmEnvelope,
	encryptAesGcmEnvelope,
	importAesGcmKey,
} from "./aes-gcm-envelope.ts";
import { RelayConfiguration } from "./config.ts";

export type CloudCredentialPayload = {
	readonly credentialType:
		| "api-key"
		| "oauth-token"
		| "repository-token"
		| "native-store";
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

const aad = (accountId: string, kind: string, version: number): Uint8Array =>
	new TextEncoder().encode(
		`zuse-cloud-credential-v1\n${accountId}\n${kind}\n${version}`,
	);
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
		"native-store",
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
	const key = yield* Effect.tryPromise({
		try: () => importAesGcmKey(Redacted.value(encodedKey)),
		catch: () => failure("vault_key_invalid"),
	});
	return CloudCredentialVault.of({
		enabled: true,
		encrypt: (accountId, kind, version, payload) =>
			Effect.tryPromise({
				try: () =>
					encryptAesGcmEnvelope({
						key,
						additionalData: aad(accountId, kind, version),
						plaintext: new TextEncoder().encode(
							JSON.stringify(Schema.encodeSync(Payload)(payload)),
						),
					}),
				catch: () => failure("credential_encrypt_failed"),
			}),
		decrypt: (accountId, kind, version, envelope) =>
			Effect.tryPromise({
				try: async () => {
					const decoded = Schema.decodeUnknownSync(Envelope)(
						JSON.parse(envelope) as unknown,
					);
					const plaintext = await decryptAesGcmEnvelope({
						key,
						additionalData: aad(accountId, kind, version),
						envelope: decoded,
					});
					return Schema.decodeUnknownSync(Payload)(
						JSON.parse(new TextDecoder().decode(plaintext)) as unknown,
					);
				},
				catch: () => failure("credential_decrypt_failed"),
			}),
	});
});
