import { RuntimeMode } from "@zuse/contracts";
import { Context, Effect, Redacted, Schema } from "effect";
import {
	decryptAesGcmEnvelope,
	encryptAesGcmEnvelope,
	importAesGcmKey,
} from "./aes-gcm-envelope.ts";
import { ApiConfiguration } from "./config.ts";

export interface CloudWorkspaceLaunchIntent {
	readonly commandId: string;
	readonly turnId: string;
	readonly title: string;
	readonly agent: string;
	readonly model: string;
	readonly runtimeMode?: RuntimeMode;
	readonly permissions: ReadonlyArray<string>;
	readonly firstMessage?: string;
	readonly pendingRename?: string;
}

export const makeCloudWorkspaceLaunchIntent = (input: {
	readonly workspaceId: string;
	readonly branch: string;
	readonly agent: string;
	readonly model: string;
	readonly runtimeMode: RuntimeMode;
	readonly permissions: ReadonlyArray<string>;
	readonly request: { readonly firstMessage?: string };
}): CloudWorkspaceLaunchIntent => {
	const firstLine = input.request.firstMessage
		?.trim()
		.split(/\r?\n/u, 1)[0]
		?.trim();
	const title =
		firstLine === undefined || firstLine.length === 0
			? input.branch
			: firstLine.length > 80
				? `${firstLine.slice(0, 77)}…`
				: firstLine;
	return {
		commandId: `launch:${input.workspaceId}`,
		turnId: `turn:${input.workspaceId}`,
		title,
		agent: input.agent,
		model: input.model,
		runtimeMode: input.runtimeMode,
		permissions: input.permissions,
		...(input.request.firstMessage === undefined
			? {}
			: { firstMessage: input.request.firstMessage }),
	};
};

export class CloudWorkspaceLaunchIntentCipherError extends Schema.TaggedErrorClass<CloudWorkspaceLaunchIntentCipherError>()(
	"CloudWorkspaceLaunchIntentCipherError",
	{ reason: Schema.String },
) {}

export interface CloudWorkspaceLaunchIntentCipherApi {
	readonly encrypt: (
		accountId: string,
		workspaceId: string,
		intent: CloudWorkspaceLaunchIntent,
	) => Effect.Effect<string, CloudWorkspaceLaunchIntentCipherError>;
	readonly decrypt: (
		accountId: string,
		workspaceId: string,
		ciphertext: string,
	) => Effect.Effect<
		CloudWorkspaceLaunchIntent,
		CloudWorkspaceLaunchIntentCipherError
	>;
}

export class CloudWorkspaceLaunchIntentCipher extends Context.Service<
	CloudWorkspaceLaunchIntentCipher,
	CloudWorkspaceLaunchIntentCipherApi
>()("@zuse/api/CloudWorkspaceLaunchIntentCipher") {}

const Envelope = Schema.Struct({
	version: Schema.Literal(1),
	iv: Schema.String,
	ciphertext: Schema.String,
});

const Intent = Schema.Struct({
	commandId: Schema.String,
	turnId: Schema.String,
	title: Schema.String,
	agent: Schema.String,
	model: Schema.String,
	runtimeMode: Schema.optional(RuntimeMode),
	permissions: Schema.Array(Schema.String),
	firstMessage: Schema.optional(Schema.String),
	pendingRename: Schema.optional(Schema.String),
});

const failure = (reason: string) =>
	new CloudWorkspaceLaunchIntentCipherError({ reason });

const aad = (accountId: string, workspaceId: string): Uint8Array =>
	new TextEncoder().encode(
		`zuse-cloud-workspace-launch-intent-v1\n${accountId}\n${workspaceId}`,
	);

export const CloudWorkspaceLaunchIntentCipherLive = Effect.gen(function* () {
	const config = yield* ApiConfiguration;
	const encodedKey = config.cloudDataEncryptionKey;
	if (encodedKey === undefined)
		return yield* Effect.fail(
			failure("launch_intent_encryption_not_configured"),
		);
	const key = yield* Effect.tryPromise({
		try: () => importAesGcmKey(Redacted.value(encodedKey)),
		catch: () => failure("launch_intent_key_invalid"),
	});
	return CloudWorkspaceLaunchIntentCipher.of({
		encrypt: (accountId, workspaceId, intent) =>
			Effect.tryPromise({
				try: () =>
					encryptAesGcmEnvelope({
						key,
						additionalData: aad(accountId, workspaceId),
						plaintext: new TextEncoder().encode(
							JSON.stringify(Schema.encodeSync(Intent)(intent)),
						),
					}),
				catch: () => failure("launch_intent_encrypt_failed"),
			}),
		decrypt: (accountId, workspaceId, ciphertext) =>
			Effect.tryPromise({
				try: async () => {
					const envelope = Schema.decodeUnknownSync(Envelope)(
						JSON.parse(ciphertext) as unknown,
					);
					const plaintext = await decryptAesGcmEnvelope({
						key,
						additionalData: aad(accountId, workspaceId),
						envelope,
					});
					return Schema.decodeUnknownSync(Intent)(
						JSON.parse(new TextDecoder().decode(plaintext)) as unknown,
					);
				},
				catch: () => failure("launch_intent_decrypt_failed"),
			}),
	});
});
