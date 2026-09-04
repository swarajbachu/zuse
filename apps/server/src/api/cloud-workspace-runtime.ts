import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { watch } from "node:fs";
import {
	access,
	mkdir,
	readFile,
	rename,
	unlink,
	writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
	type CloudMessageSendPayload,
	type CloudMessageSendResult,
	cloudCommandEligibility,
	cloudMessageSendPayloadLimitation,
	decodeCloudMessageSendPayload,
} from "@zuse/cloud-commands";
import {
	AgentSessionId,
	AgentTurnId,
	ApiPaths,
	ChatId,
	CLOUD_COMMAND_PROTOCOL_VERSION,
	CLOUD_TRANSCRIPT_CHECKPOINT_SCHEMA_VERSION,
	CloudTranscriptCheckpointPayload,
	CloudTranscriptMessagePagePayload,
	CloudWorkspaceRuntimeSummary,
	ComposerInput,
	DEFAULT_RUNTIME_MODE,
	decodeWorkspaceGatewayFrame,
	encodeWorkspaceGatewayFrame,
	FolderId,
	MessageContent,
	MessageId,
	ProviderId,
	RuntimeAcknowledgment,
	RuntimeLease,
	RuntimeMode,
	SessionId,
	WIRE_PROTOCOL_VERSION,
	WORKSPACE_GATEWAY_AUTH_EXPIRED_CLOSE,
	WORKSPACE_GATEWAY_STALE_GENERATION_CLOSE,
	WORKSPACE_GATEWAY_UPDATE_REQUIRED_CLOSE,
	workspaceGatewayArrayBuffer,
} from "@zuse/contracts";
import type { CommandReceiptIdentity } from "@zuse/domain/engine/dispatch";
import { SessionDomain } from "@zuse/domain/engine/session-domain";
import {
	cloudCommandAdditionalData,
	decryptCloudCommandBody,
	encryptCloudCommandBody,
	keyedCloudCommandFingerprint,
} from "@zuse/utils/cloud-command-crypto";
import {
	cloudTranscriptAdditionalData,
	encryptCloudTranscript,
	sha256Base64Url,
} from "@zuse/utils/cloud-transcript-crypto";
import {
	Cause,
	Clock,
	Duration,
	Effect,
	Layer,
	Option,
	Redacted,
	Schedule,
	Schema,
	Semaphore,
	Stream,
} from "effect";
import { SqlClient } from "effect/unstable/sql";
import {
	type CryptoKey,
	compactDecrypt,
	exportJWK,
	generateKeyPair,
	SignJWT,
} from "jose";
import { serializeAnnotations } from "../conversation/core/conversation-input.ts";
import {
	ChatService,
	type ChatServiceShape,
	MessageService,
} from "../conversation/services/conversation-services.ts";
import { LanAuthService } from "../lan-auth/services/lan-auth-service.ts";
import { CredentialsService } from "../provider/services/credentials-service.ts";
import {
	WorkspaceService,
	type WorkspaceServiceShape,
} from "../workspace/services/workspace-service.ts";
import { cloudStorageIncarnationId } from "./cloud-storage-incarnation.ts";

const CREDENTIALS_READY_MARKER = "/var/lib/zuse/workspace/credentials-ready";
const CREDENTIALS_READY_EVENT =
	"/var/lib/zuse/workspace/credentials-ready-event";
const REPOSITORY_READY_MARKER = "/var/lib/zuse/workspace/repository-ready";
const cloudRuntimeDataDirectory = () =>
	process.env.ZUSE_USER_DATA?.trim() || "/home/zuse/.zuse-data";

const writeOwnerOnlyFile = (
	path: string,
	contents: string,
): Effect.Effect<void, CloudWorkspaceRuntimeError> =>
	Effect.tryPromise({
		try: async () => {
			const temporaryPath = `${path}.${process.pid}.${randomUUID()}.next`;
			await mkdir(dirname(path), { recursive: true, mode: 0o700 });
			await writeFile(temporaryPath, contents, { mode: 0o600 });
			await rename(temporaryPath, path);
		},
		catch: () => fail("workspace_github_broker_state_failed"),
	});

export const writeGithubBrokerState = (
	config: CloudWorkspaceRuntimeConfig,
	runtimeCredential: string,
): Effect.Effect<void, CloudWorkspaceRuntimeError> => {
	const directory = cloudRuntimeDataDirectory();
	return Effect.all(
		[
			writeOwnerOnlyFile(
				join(directory, "github-broker.json"),
				`${JSON.stringify({
					credentialUrl: `${config.apiUrl}${ApiPaths.cloudWorkspaceRuntimeGithubCredential(config.workspaceId)}`,
				})}\n`,
			),
			writeOwnerOnlyFile(
				join(directory, "cloud-runtime-credential"),
				`${runtimeCredential}\n`,
			),
		],
		{ discard: true },
	);
};

export interface CloudWorkspaceRuntimeConfig {
	readonly workspaceId: string;
	readonly apiUrl: string;
	readonly bootToken: Redacted.Redacted<string>;
	readonly bootTokenFile?: string;
	readonly localPort: number;
	readonly workspaceRoot: string;
}

export class CloudWorkspaceRuntimeError extends Schema.TaggedErrorClass<CloudWorkspaceRuntimeError>()(
	"CloudWorkspaceRuntimeError",
	{
		reason: Schema.String,
		httpStatus: Schema.optional(Schema.Number),
	},
) {}

const fail = (reason: string, httpStatus?: number) =>
	new CloudWorkspaceRuntimeError({
		reason,
		...(httpStatus === undefined ? {} : { httpStatus }),
	});

/** A capped, jittered retry policy shared by enrollment and gateway recovery. */
export const cloudRuntimeRetrySchedule = Schedule.exponential(
	"250 millis",
).pipe(
	Schedule.modifyDelay(({ duration }) =>
		Effect.sync(() => {
			const capped = Math.min(Duration.toMillis(duration), 16_000);
			return capped * (0.75 + Math.random() * 0.5);
		}),
	),
);

/**
 * Runtime enrollment depends on a workspace row written immediately before
 * the sandbox starts. A transient api/database error must not strand a
 * healthy runtime, and retry has one supervised policy instead of fixed loops.
 */
export const retryCloudWorkspaceBootstrap = <A, E, R>(
	bootstrap: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
	bootstrap.pipe(Effect.retry(cloudRuntimeRetrySchedule));

export const runtimeReadyPhaseOnGatewayOpen = (
	repositoryReady: boolean,
): "repository-ready" | null => (repositoryReady ? "repository-ready" : null);

const LOCAL_RPC_HANDOFF_MAX_FRAMES = 32;
const LOCAL_RPC_HANDOFF_MAX_BYTES = 256 * 1024;

export type WorkspaceLocalFrameQueue = {
	readonly frames: Array<string | ArrayBuffer>;
	bytes: number;
};

/**
 * The gateway owns no replay buffer, but a newly announced client can send its
 * RPC handshake before the runtime's localhost socket reaches OPEN. Keep only
 * that short, bounded handoff window in the authoritative runtime process.
 */
export const bufferWorkspaceLocalFrame = (
	queue: WorkspaceLocalFrameQueue,
	payload: string | ArrayBuffer,
): boolean => {
	const bytes =
		typeof payload === "string"
			? new TextEncoder().encode(payload).byteLength
			: payload.byteLength;
	if (
		queue.frames.length >= LOCAL_RPC_HANDOFF_MAX_FRAMES ||
		queue.bytes + bytes > LOCAL_RPC_HANDOFF_MAX_BYTES
	)
		return false;
	queue.frames.push(payload);
	queue.bytes += bytes;
	return true;
};

const BootstrapResponse = Schema.Struct({
	workspaceId: Schema.String,
	providerSandboxId: Schema.String,
	runtimeCredential: Schema.String,
	runtimeGatewayCredential: Schema.String,
	runtimeCredentialExpiresAt: Schema.Number,
	runtimeGeneration: Schema.Number,
	gatewayEpoch: Schema.Number,
	gatewayUrl: Schema.String,
	gatewayProtocol: Schema.String,
	chatId: Schema.String,
	initialSessionId: Schema.String,
	launchIntent: Schema.optional(
		Schema.Struct({
			commandId: Schema.String,
			turnId: Schema.String,
			title: Schema.String,
			agent: Schema.String,
			model: Schema.String,
			runtimeMode: Schema.optional(RuntimeMode),
			permissions: Schema.Array(Schema.String),
			firstMessage: Schema.optional(Schema.String),
			pendingRename: Schema.optional(Schema.String),
		}),
	),
	sealedTranscriptKey: Schema.String,
	sealedProviderGrant: Schema.optional(Schema.String),
});

const ProviderGrant = Schema.Struct({
	version: Schema.Literal(1),
	providerId: Schema.Literals(["claude", "codex", "cursor", "grok"]),
	method: Schema.Literals(["subscription", "api-key", "custom"]),
	env: Schema.Record(Schema.String, Schema.String),
	baseUrl: Schema.optional(Schema.String),
	modelProvider: Schema.optional(Schema.String),
	workspaceId: Schema.String,
	runtimeGeneration: Schema.Number,
	issuedAt: Schema.Number,
});

const IMAGE_PROVIDER_IDS = ["claude", "codex", "cursor", "grok"] as const;
const ImageProviderSecrets = Schema.Record(
	Schema.String,
	Schema.Struct({
		method: Schema.Literals(["subscription", "api-key", "custom"]),
		secret: Schema.String,
	}),
);

export const decodeImageProviderSecrets = (raw: string) =>
	Effect.try({
		try: () => JSON.parse(raw) as unknown,
		catch: () => fail("workspace_image_credentials_invalid"),
	}).pipe(
		Effect.flatMap(Schema.decodeUnknownEffect(ImageProviderSecrets)),
		Effect.filterOrFail(
			(decoded) =>
				Object.keys(decoded).every((providerId) =>
					IMAGE_PROVIDER_IDS.includes(
						providerId as (typeof IMAGE_PROVIDER_IDS)[number],
					),
				),
			() => fail("workspace_image_credentials_invalid"),
		),
		Effect.mapError(() => fail("workspace_image_credentials_invalid")),
	);

const installImageProviderSecrets = Effect.fn("installImageProviderSecrets")(
	function* (credentials: CredentialsService["Service"]) {
		const path = "/home/zuse/.zuse-image/provider-secrets.json";
		const raw = yield* Effect.promise(() =>
			readFile(path, "utf8").catch(() => null),
		);
		if (raw === null) return;
		const decoded = yield* decodeImageProviderSecrets(raw);
		for (const [providerId, entry] of Object.entries(decoded)) {
			yield* ensureProviderCredential(credentials, {
				providerId: providerId as "claude" | "codex" | "cursor" | "grok",
				kind:
					providerId === "claude" && entry.method === "subscription"
						? "oauth-token"
						: "api-key",
				secret: entry.secret,
			});
		}
		// The account image retains the source file. A chat fork removes its copy
		// after importing it into the runtime's encrypted local credential store.
		yield* Effect.promise(() => unlink(path).catch(() => undefined));
	},
);

const decodeBase64Url = (value: string): Uint8Array<ArrayBuffer> =>
	new Uint8Array(Buffer.from(value, "base64url"));

const decryptProviderGrant = Effect.fn("decryptCloudProviderGrant")(function* (
	sealed: string,
	privateKey: CryptoKey,
) {
	const envelope = yield* Effect.try({
		try: () => {
			const parsed = JSON.parse(
				Buffer.from(sealed, "base64url").toString("utf8"),
			) as Record<string, unknown>;
			if (
				typeof parsed.wrappedKey !== "string" ||
				typeof parsed.iv !== "string" ||
				typeof parsed.tag !== "string" ||
				typeof parsed.ciphertext !== "string"
			)
				throw new Error("invalid_envelope");
			return {
				wrappedKey: parsed.wrappedKey,
				iv: parsed.iv,
				tag: parsed.tag,
				ciphertext: parsed.ciphertext,
			};
		},
		catch: () => fail("workspace_provider_grant_invalid"),
	});
	const plaintext = yield* Effect.tryPromise({
		try: async () => {
			const rawKey = await crypto.subtle.decrypt(
				{ name: "RSA-OAEP" },
				privateKey,
				decodeBase64Url(envelope.wrappedKey),
			);
			const aesKey = await crypto.subtle.importKey(
				"raw",
				rawKey,
				{ name: "AES-GCM" },
				false,
				["decrypt"],
			);
			const ciphertext = Buffer.concat([
				Buffer.from(envelope.ciphertext, "base64url"),
				Buffer.from(envelope.tag, "base64url"),
			]);
			return crypto.subtle.decrypt(
				{
					name: "AES-GCM",
					iv: decodeBase64Url(envelope.iv),
					tagLength: 128,
				},
				aesKey,
				ciphertext,
			);
		},
		catch: () => fail("workspace_provider_grant_decryption_failed"),
	});
	return yield* Schema.decodeUnknownEffect(ProviderGrant)(
		JSON.parse(new TextDecoder().decode(plaintext)),
	).pipe(Effect.mapError(() => fail("workspace_provider_grant_invalid")));
});

const installCodexApiKey = (
	secret: string,
): Effect.Effect<void, CloudWorkspaceRuntimeError> =>
	Effect.callback<void, CloudWorkspaceRuntimeError>((resume) => {
		const child = spawn("codex", ["login", "--with-api-key"], {
			stdio: ["pipe", "ignore", "ignore"],
		});
		const timer = setTimeout(() => child.kill("SIGTERM"), 30_000);
		child.once("error", () => {
			clearTimeout(timer);
			resume(Effect.fail(fail("workspace_codex_login_failed")));
		});
		child.once("exit", (code) => {
			clearTimeout(timer);
			resume(
				code === 0
					? Effect.void
					: Effect.fail(fail("workspace_codex_login_failed")),
			);
		});
		child.stdin.end(`${secret}\n`);
		return Effect.sync(() => child.kill("SIGTERM"));
	});

const ensureProviderCredential = Effect.fn("ensureCloudProviderCredential")(
	function* (
		credentials: CredentialsService["Service"],
		input: {
			readonly providerId: "claude" | "codex" | "cursor" | "grok";
			readonly kind: "oauth-token" | "api-key";
			readonly secret: string;
		},
	) {
		const existing = yield* credentials
			.getProviderCredential(input.providerId)
			.pipe(
				Effect.mapError(() =>
					fail("workspace_provider_credential_store_failed"),
				),
			);
		if (existing?.kind === input.kind && existing.secret === input.secret)
			return;
		yield* credentials
			.setProviderCredential(input.providerId, {
				kind: input.kind,
				secret: input.secret,
			})
			.pipe(
				Effect.mapError(() =>
					fail("workspace_provider_credential_store_failed"),
				),
			);
		if (input.providerId === "codex") yield* installCodexApiKey(input.secret);
	},
);

const RuntimeCredentialRenewalResponse = Schema.Struct({
	workspaceId: Schema.String,
	requestId: Schema.String,
	runtimeCredential: Schema.String,
	expiresAt: Schema.Number,
	generation: Schema.Number,
	gatewayEpoch: Schema.Number,
});

const RuntimeBootstrapAckResponse = Schema.Struct({
	acknowledged: Schema.Literal(true),
});

const RuntimeSummaryResponse = Schema.Struct({
	applied: Schema.Boolean,
	summaryRevision: Schema.Number,
	sessionHeadVersion: Schema.Number,
});

const RuntimeTranscriptCheckpointResponse = Schema.Struct({
	applied: Schema.Boolean,
	cursor: Schema.Struct({ epoch: Schema.String, version: Schema.Number }),
	archiveRequested: Schema.Boolean,
});
const RuntimeTranscriptMessagePageResponse = Schema.Struct({
	applied: Schema.Boolean,
});

interface RuntimeCredentialState {
	credential: string;
	gatewayCredential?: string;
	expiresAt: number;
	generation: number;
	gatewayEpoch: number;
}

type RuntimeSummaryReason = "initial" | "activity" | "title" | "settled";

interface CloudRuntimeSummaryPublisher {
	readonly publish: (
		reason: RuntimeSummaryReason,
	) => Effect.Effect<boolean, CloudWorkspaceRuntimeError>;
}

interface CloudRuntimeCheckpointPublisher {
	readonly mark: (urgent?: boolean) => void;
	readonly flush: Effect.Effect<boolean, CloudWorkspaceRuntimeError>;
}

export const makeCloudRuntimeCheckpointPublisher = Effect.fn(
	"CloudWorkspaceRuntime.makeCheckpointPublisher",
)(function* (input: {
	readonly read: Effect.Effect<
		{
			readonly cursor: { readonly epoch: string; readonly version: number };
			readonly projection: CloudTranscriptCheckpointPayload["projection"];
		},
		CloudWorkspaceRuntimeError
	>;
	readonly write: (checkpoint: {
		readonly cursor: { readonly epoch: string; readonly version: number };
		readonly ciphertext: string;
		readonly ciphertextSha256: string;
	}) => Effect.Effect<void, CloudWorkspaceRuntimeError>;
	readonly readPage: (beforeSequence: number) => Effect.Effect<
		{
			readonly messages: CloudTranscriptMessagePagePayload["messages"];
			readonly olderMessageSequence: number | null;
		},
		CloudWorkspaceRuntimeError
	>;
	readonly writePage: (page: {
		readonly cursor: { readonly epoch: string; readonly version: number };
		readonly beforeSequence: number;
		readonly ciphertext: string;
		readonly ciphertextSha256: string;
	}) => Effect.Effect<void, CloudWorkspaceRuntimeError>;
	readonly workspaceId: string;
	readonly sessionId: string;
	readonly transcriptKey: string;
}) {
	const lock = yield* Semaphore.make(1);
	let dirtyRevision = 1;
	let acceptedVersion = -1;
	// A restarted runtime may already own a long settled transcript. Publish its
	// immutable older pages once even if no new turn event arrives after boot.
	let historyRequested = true;
	let historyVersion = -1;
	const mark = (urgent = false) => {
		dirtyRevision += 1;
		if (urgent) historyRequested = true;
	};
	const flush = lock.withPermits(1)(
		Effect.gen(function* () {
			const pendingRevision = dirtyRevision;
			const snapshot = yield* input.read;
			const publishHead = snapshot.cursor.version > acceptedVersion;
			const publishHistory =
				historyRequested && snapshot.cursor.version > historyVersion;
			if (!publishHead && !publishHistory) {
				if (dirtyRevision === pendingRevision) dirtyRevision = 0;
				return false;
			}
			if (publishHead) {
				const payload = new CloudTranscriptCheckpointPayload({
					schemaVersion: CLOUD_TRANSCRIPT_CHECKPOINT_SCHEMA_VERSION,
					workspaceId: input.workspaceId,
					sessionId: AgentSessionId.make(input.sessionId),
					cursor: snapshot.cursor,
					projection: snapshot.projection,
				});
				const plaintext = new TextEncoder().encode(
					JSON.stringify(
						Schema.encodeSync(CloudTranscriptCheckpointPayload)(payload),
					),
				);
				const ciphertext = yield* Effect.tryPromise({
					try: () =>
						encryptCloudTranscript({
							encodedKey: input.transcriptKey,
							additionalData: cloudTranscriptAdditionalData({
								workspaceId: input.workspaceId,
								sessionId: input.sessionId,
								epoch: snapshot.cursor.epoch,
								version: snapshot.cursor.version,
								schemaVersion: CLOUD_TRANSCRIPT_CHECKPOINT_SCHEMA_VERSION,
							}),
							plaintext,
						}),
					catch: () => fail("workspace_transcript_encryption_failed"),
				});
				yield* input.write({
					cursor: snapshot.cursor,
					ciphertext,
					ciphertextSha256: yield* Effect.promise(() =>
						sha256Base64Url(ciphertext),
					),
				});
				acceptedVersion = snapshot.cursor.version;
			}
			if (publishHistory) {
				let beforeSequence = snapshot.projection.olderMessageSequence ?? null;
				while (beforeSequence !== null) {
					const pageBeforeSequence = beforeSequence;
					const page = yield* input.readPage(pageBeforeSequence);
					const payload = new CloudTranscriptMessagePagePayload({
						schemaVersion: CLOUD_TRANSCRIPT_CHECKPOINT_SCHEMA_VERSION,
						workspaceId: input.workspaceId,
						sessionId: AgentSessionId.make(input.sessionId),
						cursor: snapshot.cursor,
						beforeSequence: pageBeforeSequence,
						messages: page.messages,
						olderMessageSequence: page.olderMessageSequence,
					});
					const ciphertext = yield* Effect.tryPromise({
						try: () =>
							encryptCloudTranscript({
								encodedKey: input.transcriptKey,
								additionalData: cloudTranscriptAdditionalData({
									workspaceId: input.workspaceId,
									sessionId: input.sessionId,
									epoch: snapshot.cursor.epoch,
									version: snapshot.cursor.version,
									schemaVersion: CLOUD_TRANSCRIPT_CHECKPOINT_SCHEMA_VERSION,
									pageBeforeSequence,
								}),
								plaintext: new TextEncoder().encode(
									JSON.stringify(
										Schema.encodeSync(CloudTranscriptMessagePagePayload)(
											payload,
										),
									),
								),
							}),
						catch: () => fail("workspace_transcript_encryption_failed"),
					});
					yield* input.writePage({
						cursor: snapshot.cursor,
						beforeSequence: pageBeforeSequence,
						ciphertext,
						ciphertextSha256: yield* Effect.promise(() =>
							sha256Base64Url(ciphertext),
						),
					});
					if (
						page.olderMessageSequence !== null &&
						page.olderMessageSequence >= pageBeforeSequence
					)
						return yield* Effect.fail(
							fail("workspace_transcript_page_cursor_invalid"),
						);
					beforeSequence = page.olderMessageSequence;
				}
				historyVersion = snapshot.cursor.version;
				if (dirtyRevision === pendingRevision) historyRequested = false;
			}
			if (dirtyRevision === pendingRevision) dirtyRevision = 0;
			return true;
		}),
	);
	return { mark, flush } satisfies CloudRuntimeCheckpointPublisher;
});

/**
 * Serializes summary writes and retries a failed revision instead of skipping
 * it. Activity checkpoints are bounded to one write every 30 seconds; title
 * and settlement changes bypass the throttle so the catalog converges at turn
 * boundaries without carrying transcript content through API.
 */
export const makeCloudRuntimeSummaryPublisher = Effect.fn(
	"CloudWorkspaceRuntime.makeSummaryPublisher",
)(function* (input: {
	readonly now: Effect.Effect<number>;
	readonly read: Effect.Effect<
		{
			readonly title: string;
			readonly lastActivityAt: number;
			readonly sessionHeadVersion: number;
		},
		CloudWorkspaceRuntimeError
	>;
	readonly write: (
		summary: CloudWorkspaceRuntimeSummary,
	) => Effect.Effect<
		{ readonly applied: boolean; readonly summaryRevision: number },
		CloudWorkspaceRuntimeError
	>;
	readonly activityThrottleMs?: number;
}) {
	const lock = yield* Semaphore.make(1);
	let acceptedRevision = 0;
	let lastActivityPublishedAt = Number.NEGATIVE_INFINITY;
	const throttleMs = input.activityThrottleMs ?? 30_000;
	const summary = (
		snapshot: {
			readonly title: string;
			readonly lastActivityAt: number;
			readonly sessionHeadVersion: number;
		},
		summaryRevision: number,
	) => new CloudWorkspaceRuntimeSummary({ ...snapshot, summaryRevision });
	const publish: CloudRuntimeSummaryPublisher["publish"] = (reason) =>
		lock.withPermits(1)(
			Effect.gen(function* () {
				const now = yield* input.now;
				if (reason === "activity" && now - lastActivityPublishedAt < throttleMs)
					return false;
				const snapshot = yield* input.read;
				let nextRevision = acceptedRevision + 1;
				let response = yield* input.write(summary(snapshot, nextRevision));
				// A preserved process can reconnect after API already accepted a
				// higher revision. Rebase once and apply the current snapshot instead
				// of waiting for another user action to correct stale catalog metadata.
				if (!response.applied && response.summaryRevision >= nextRevision) {
					nextRevision = response.summaryRevision + 1;
					response = yield* input.write(summary(snapshot, nextRevision));
				}
				acceptedRevision = Math.max(nextRevision, response.summaryRevision);
				if (!response.applied)
					return yield* Effect.fail(fail("workspace_summary_rejected"));
				if (reason === "activity") lastActivityPublishedAt = now;
				return true;
			}),
		);
	return { publish } satisfies CloudRuntimeSummaryPublisher;
});

export const signRuntimeRenewalProof = (input: {
	readonly privateKey: CryptoKey;
	readonly apiIssuer: string;
	readonly workspaceId: string;
	readonly requestId: string;
	readonly generation: number;
	readonly gatewayEpoch: number;
	readonly nowMs: number;
}): Effect.Effect<string, CloudWorkspaceRuntimeError> =>
	Effect.tryPromise({
		try: () =>
			new SignJWT({
				workspaceId: input.workspaceId,
				requestId: input.requestId,
				generation: input.generation,
				gatewayEpoch: input.gatewayEpoch,
			})
				.setProtectedHeader({
					alg: "EdDSA",
					typ: "workspace-runtime-renewal+jwt",
				})
				.setAudience(input.apiIssuer)
				.setIssuedAt(Math.floor(input.nowMs / 1_000))
				.setExpirationTime(Math.floor(input.nowMs / 1_000) + 120)
				.sign(input.privateKey),
		catch: () => fail("workspace_runtime_renewal_proof_failed"),
	});

export const runtimeCredentialRenewalDelayMs = (
	expiresAt: number,
	nowMs: number,
): number => Math.max(0, Math.floor((expiresAt - nowMs) / 2));

const renewRuntimeCredential = (input: {
	readonly config: CloudWorkspaceRuntimeConfig;
	readonly signingPrivateKey: CryptoKey;
	readonly state: RuntimeCredentialState;
	readonly requestId: string;
}): Effect.Effect<void, CloudWorkspaceRuntimeError> =>
	Effect.gen(function* () {
		const current = { ...input.state };
		while (true) {
			const nowMs = yield* Clock.currentTimeMillis;
			if (nowMs >= current.expiresAt)
				return yield* Effect.fail(fail("workspace_runtime_credential_expired"));
			const proof = yield* signRuntimeRenewalProof({
				privateKey: input.signingPrivateKey,
				apiIssuer: input.config.apiUrl,
				workspaceId: input.config.workspaceId,
				requestId: input.requestId,
				generation: current.generation,
				gatewayEpoch: current.gatewayEpoch,
				nowMs,
			});
			const result = yield* requestJson({
				schema: RuntimeCredentialRenewalResponse,
				url: `${input.config.apiUrl}${ApiPaths.cloudWorkspaceRuntimeCredentialsRenew(
					input.config.workspaceId,
				)}`,
				token: current.credential,
				method: "POST",
				body: { requestId: input.requestId, proof },
			}).pipe(Effect.result);
			if (result._tag === "Success") {
				if (
					result.success.workspaceId !== input.config.workspaceId ||
					result.success.generation !== current.generation ||
					result.success.gatewayEpoch !== current.gatewayEpoch
				)
					return yield* Effect.fail(
						fail("workspace_runtime_renewal_fence_changed"),
					);
				yield* writeGithubBrokerState(
					input.config,
					result.success.runtimeCredential,
				);
				input.state.credential = result.success.runtimeCredential;
				input.state.gatewayCredential = undefined;
				input.state.expiresAt = result.success.expiresAt;
				return;
			}
			const afterFailureMs = yield* Clock.currentTimeMillis;
			const remaining = current.expiresAt - afterFailureMs;
			if (remaining <= 0)
				return yield* Effect.fail(fail("workspace_runtime_credential_expired"));
			const retryDelay = Math.min(
				remaining,
				1_000 + Math.floor(Math.random() * 1_000),
			);
			yield* Effect.sleep(Duration.millis(retryDelay));
		}
	});

/**
 * Renew at half-life and keep a single request id across response-loss retries.
 * If the lease actually expires, terminate this fenced runtime so the cloud
 * reconciler can issue a fresh generation instead of leaving a zombie gateway.
 */
const superviseRuntimeCredential = (input: {
	readonly config: CloudWorkspaceRuntimeConfig;
	readonly signingPrivateKey: CryptoKey;
	readonly state: RuntimeCredentialState;
}): Effect.Effect<never, never> =>
	Effect.forever(
		Effect.gen(function* () {
			const nowMs = yield* Clock.currentTimeMillis;
			yield* Effect.sleep(
				Duration.millis(
					runtimeCredentialRenewalDelayMs(input.state.expiresAt, nowMs),
				),
			);
			const result = yield* renewRuntimeCredential({
				...input,
				requestId: randomUUID(),
			}).pipe(Effect.result);
			if (result._tag === "Failure") {
				yield* Effect.logError("cloud runtime credential renewal failed", {
					reason: result.failure.reason,
				});
				yield* Effect.sync(() => process.kill(process.pid, "SIGTERM"));
			}
		}),
	);

const requestJson = <A, I>(input: {
	readonly schema: Schema.Codec<A, I>;
	readonly url: string;
	readonly token: string;
	readonly method?: "GET" | "POST";
	readonly body?: unknown;
	readonly timeoutMs?: number;
}): Effect.Effect<A, CloudWorkspaceRuntimeError> =>
	Effect.tryPromise({
		try: async () => {
			let response: Response;
			try {
				response = await fetch(input.url, {
					method: input.method ?? "GET",
					signal: AbortSignal.timeout(input.timeoutMs ?? 30_000),
					headers: {
						authorization: `Bearer ${input.token}`,
						...(input.body === undefined
							? {}
							: { "content-type": "application/json" }),
					},
					body:
						input.body === undefined ? undefined : JSON.stringify(input.body),
				});
			} catch {
				throw fail("api_request_failed");
			}
			if (!response.ok) throw fail("api_http_rejected", response.status);
			try {
				return (await response.json()) as unknown;
			} catch {
				throw fail("api_invalid_response");
			}
		},
		catch: (cause) =>
			cause instanceof CloudWorkspaceRuntimeError
				? cause
				: fail("api_request_failed"),
	}).pipe(
		Effect.flatMap(Schema.decodeUnknownEffect(input.schema)),
		Effect.mapError((error) =>
			error instanceof CloudWorkspaceRuntimeError
				? error
				: fail("api_invalid_response"),
		),
	);

const RuntimeLeasePage = Schema.Struct({
	leases: Schema.Array(RuntimeLease),
	// Optional for additive compatibility with the first v3-capable API build.
	fenceRequired: Schema.optional(Schema.Boolean),
});

const ReceiptMessageEvent = Schema.Struct({
	_tag: Schema.Literal("MessagePersisted"),
	messageId: MessageId,
	turnId: Schema.String,
	role: Schema.Literal("user"),
	kind: Schema.Literals(["user", "user_rich"]),
	contentJson: Schema.String,
	parentItemId: Schema.Null,
});

const ReceiptProviderTurnEvent = Schema.Struct({
	_tag: Schema.Literal("ProviderTurnRequested"),
	turnId: Schema.String,
	providerInputJson: Schema.String,
});

const CloudMailboxCommandRejectionCategory = Schema.Literals([
	"command-decryption-failed",
	"command-fingerprint-mismatch",
	"command-kind-not-supported",
	"command-schema-not-supported",
	"command-payload-invalid",
	"command-payload-too-large",
	"command-payload-identity-mismatch",
	"command-dependencies-not-supported",
	"command-goal-mode-not-supported",
	"runtime-generation-mismatch",
	"runtime-provider-sandbox-mismatch",
	"runtime-lease-expired",
	"runtime-storage-incarnation-mismatch",
	"runtime-receipt-conflict",
	"runtime-receipt-invalid",
	"runtime-receipt-missing",
	"runtime-receipt-store-unavailable",
	"session-not-found",
	"workspace-directory-unavailable",
	"result-encryption-failed",
	"runtime-apply-failed",
]);
export type CloudMailboxCommandRejectionCategory =
	typeof CloudMailboxCommandRejectionCategory.Type;

export class CloudMailboxApplyError extends Schema.TaggedErrorClass<CloudMailboxApplyError>()(
	"CloudMailboxApplyError",
	{ category: CloudMailboxCommandRejectionCategory },
) {}

const rejectCloudMailboxCommand = (
	category: CloudMailboxCommandRejectionCategory,
) => new CloudMailboxApplyError({ category });

export interface CloudMailboxCommandReceipt {
	readonly commandId: string;
	readonly streamKind: string;
	readonly streamId: string;
	readonly streamVersion: number;
	readonly eventIdsJson: string;
	readonly resultJson: string | null;
	readonly fingerprint: string | null;
	readonly commandKind: string | null;
	readonly schemaVersion: number | null;
	readonly storageIncarnationId: string | null;
	readonly messageEventJson: string | null;
	readonly providerTurnEventJson: string | null;
}

export interface CloudMailboxCommandIdentity extends CommandReceiptIdentity {
	readonly commandId: string;
	readonly streamId: string;
}

export interface CloudMailboxReceiptStore {
	readonly read: (
		commandId: string,
	) => Effect.Effect<CloudMailboxCommandReceipt | null, CloudMailboxApplyError>;
	readonly bindIdentity: (
		input: CloudMailboxCommandIdentity,
	) => Effect.Effect<void, CloudMailboxApplyError>;
}

const makeCloudMailboxReceiptStore = (
	sql: SqlClient.SqlClient,
): CloudMailboxReceiptStore => ({
	read: (commandId) =>
		sql<{
			readonly command_id: string;
			readonly stream_kind: string;
			readonly stream_id: string;
			readonly stream_version: number;
			readonly event_ids_json: string;
			readonly result_json: string | null;
			readonly fingerprint: string | null;
			readonly command_kind: string | null;
			readonly schema_version: number | null;
			readonly storage_incarnation_id: string | null;
			readonly message_event_json: string | null;
			readonly provider_turn_event_json: string | null;
		}>`
			SELECT receipt.command_id, receipt.stream_kind, receipt.stream_id,
				receipt.stream_version, receipt.event_ids_json, receipt.result_json,
				receipt.fingerprint, receipt.command_kind, receipt.schema_version,
				receipt.storage_incarnation_id,
				(
					SELECT event.payload_json
					FROM events AS event
					WHERE event.stream_kind = 'session'
						AND event.stream_id = receipt.stream_id
						AND event.type = 'MessagePersisted'
						AND event.event_id IN (
							SELECT value FROM json_each(receipt.event_ids_json)
						)
					ORDER BY event.stream_version
					LIMIT 1
				) AS message_event_json,
				(
					SELECT event.payload_json
					FROM events AS event
					WHERE event.stream_kind = 'session'
						AND event.stream_id = receipt.stream_id
						AND event.type = 'ProviderTurnRequested'
						AND event.event_id IN (
							SELECT value FROM json_each(receipt.event_ids_json)
						)
					ORDER BY event.stream_version
					LIMIT 1
				) AS provider_turn_event_json
			FROM command_receipts AS receipt
			WHERE receipt.command_id = ${commandId}
			LIMIT 1
		`.pipe(
			Effect.map((rows) => {
				const row = rows[0];
				return row === undefined
					? null
					: {
							commandId: row.command_id,
							streamKind: row.stream_kind,
							streamId: row.stream_id,
							streamVersion: row.stream_version,
							eventIdsJson: row.event_ids_json,
							resultJson: row.result_json,
							fingerprint: row.fingerprint,
							commandKind: row.command_kind,
							schemaVersion: row.schema_version,
							storageIncarnationId: row.storage_incarnation_id,
							messageEventJson: row.message_event_json,
							providerTurnEventJson: row.provider_turn_event_json,
						};
			}),
			Effect.mapError(() =>
				rejectCloudMailboxCommand("runtime-receipt-store-unavailable"),
			),
		),
	bindIdentity: (identity) =>
		sql`
			UPDATE command_receipts SET
				fingerprint = COALESCE(fingerprint, ${identity.fingerprint}),
				command_kind = COALESCE(command_kind, ${identity.commandKind}),
				schema_version = COALESCE(schema_version, ${identity.schemaVersion}),
				storage_incarnation_id = COALESCE(
					storage_incarnation_id,
					${identity.storageIncarnationId}
				)
			WHERE command_id = ${identity.commandId}
				AND stream_kind = 'session'
				AND stream_id = ${identity.streamId}
				AND (fingerprint IS NULL OR fingerprint = ${identity.fingerprint})
				AND (command_kind IS NULL OR command_kind = ${identity.commandKind})
				AND (schema_version IS NULL OR schema_version = ${identity.schemaVersion})
				AND (
					storage_incarnation_id IS NULL OR
					storage_incarnation_id = ${identity.storageIncarnationId}
				)
		`.pipe(
			Effect.mapError(() =>
				rejectCloudMailboxCommand("runtime-receipt-store-unavailable"),
			),
			Effect.asVoid,
		),
});

const receiptConflict = (
	receipt: CloudMailboxCommandReceipt,
	identity: CloudMailboxCommandIdentity,
): boolean =>
	receipt.commandId !== identity.commandId ||
	receipt.streamKind !== "session" ||
	receipt.streamId !== identity.streamId ||
	(receipt.fingerprint !== null &&
		receipt.fingerprint !== identity.fingerprint) ||
	(receipt.commandKind !== null &&
		receipt.commandKind !== identity.commandKind) ||
	(receipt.schemaVersion !== null &&
		receipt.schemaVersion !== identity.schemaVersion) ||
	(receipt.storageIncarnationId !== null &&
		receipt.storageIncarnationId !== identity.storageIncarnationId);

const receiptMatchesMessagePayload = (
	receipt: CloudMailboxCommandReceipt,
	payload: CloudMessageSendPayload,
): boolean => {
	if (
		receipt.messageEventJson === null ||
		receipt.providerTurnEventJson === null
	)
		return false;
	try {
		const messageEvent = Schema.decodeUnknownOption(ReceiptMessageEvent)(
			JSON.parse(receipt.messageEventJson),
		);
		const providerEvent = Schema.decodeUnknownOption(ReceiptProviderTurnEvent)(
			JSON.parse(receipt.providerTurnEventJson),
		);
		if (Option.isNone(messageEvent) || Option.isNone(providerEvent))
			return false;
		const content = Schema.decodeUnknownOption(MessageContent)(
			JSON.parse(messageEvent.value.contentJson),
		);
		const providerInput = Schema.decodeUnknownOption(ComposerInput)(
			JSON.parse(providerEvent.value.providerInputJson),
		);
		if (Option.isNone(content) || Option.isNone(providerInput)) return false;

		const composer = payload.input;
		const text = composer?.text ?? payload.text ?? "";
		const attachments = (composer?.attachments ?? []).filter(
			(attachment) => !attachment.id.startsWith("pending-"),
		);
		const fileRefs = composer?.fileRefs ?? [];
		const skillRefs = composer?.skillRefs ?? [];
		const annotations = composer?.annotations ?? [];
		const rich =
			attachments.length > 0 ||
			fileRefs.length > 0 ||
			skillRefs.length > 0 ||
			annotations.length > 0;
		const persisted = content.value;
		if (persisted._tag !== "user" && persisted._tag !== "user_rich")
			return false;
		if (
			messageEvent.value.turnId !== providerEvent.value.turnId ||
			messageEvent.value.messageId !== payload.clientMessageId ||
			messageEvent.value.kind !== persisted._tag ||
			persisted.text !== text ||
			persisted.goal !== false ||
			persisted.origin !== undefined
		)
			return false;
		if (rich) {
			if (
				persisted._tag !== "user_rich" ||
				!isDeepStrictEqual(persisted.attachments, attachments) ||
				!isDeepStrictEqual(persisted.fileRefs, fileRefs) ||
				!isDeepStrictEqual(persisted.skillRefs, skillRefs) ||
				!isDeepStrictEqual(persisted.annotations, annotations)
			)
				return false;
		} else if (persisted._tag !== "user") return false;

		const expectedProviderText = [
			annotations.length > 0 ? serializeAnnotations(annotations) : null,
			text,
		]
			.filter((part): part is string => part !== null && part.length > 0)
			.join("\n\n")
			.trim();
		return (
			providerInput.value.text === expectedProviderText &&
			providerInput.value.asGoal === undefined &&
			isDeepStrictEqual(providerInput.value.attachments, attachments) &&
			isDeepStrictEqual(providerInput.value.fileRefs, fileRefs) &&
			isDeepStrictEqual(providerInput.value.skillRefs, skillRefs) &&
			isDeepStrictEqual(providerInput.value.annotations, annotations)
		);
	} catch {
		return false;
	}
};

const receiptProvesDurableMessage = (
	receipt: CloudMailboxCommandReceipt,
	payload: CloudMessageSendPayload,
): boolean => {
	if (
		!Number.isSafeInteger(receipt.streamVersion) ||
		receipt.streamVersion < 1 ||
		receipt.resultJson === null
	)
		return false;
	try {
		const eventIds = JSON.parse(receipt.eventIdsJson) as unknown;
		const result = JSON.parse(receipt.resultJson) as unknown;
		if (
			!Array.isArray(eventIds) ||
			eventIds.length === 0 ||
			!eventIds.every((eventId) => typeof eventId === "string") ||
			typeof result !== "object" ||
			result === null
		)
			return false;
		if (!receiptMatchesMessagePayload(receipt, payload)) return false;
		const durableResult = result as Record<string, unknown>;
		const durableEventIds = durableResult.eventIds;
		return (
			durableResult.commandId === receipt.commandId &&
			durableResult.streamId === receipt.streamId &&
			durableResult.streamVersion === receipt.streamVersion &&
			Array.isArray(durableEventIds) &&
			durableEventIds.length === eventIds.length &&
			durableEventIds.every((eventId, index) => eventId === eventIds[index])
		);
	} catch {
		return false;
	}
};

const receiptIsDurableAndBound = (
	receipt: CloudMailboxCommandReceipt,
	identity: CloudMailboxCommandIdentity,
	payload: CloudMessageSendPayload,
): boolean =>
	!receiptConflict(receipt, identity) &&
	receipt.fingerprint === identity.fingerprint &&
	receipt.commandKind === identity.commandKind &&
	receipt.schemaVersion === identity.schemaVersion &&
	receipt.storageIncarnationId === identity.storageIncarnationId &&
	receiptProvesDurableMessage(receipt, payload);

const verifyAndBindCloudMailboxReceipt = Effect.fn(
	"CloudWorkspaceRuntime.verifyAndBindMailboxReceipt",
)(function* (input: {
	readonly receipt: CloudMailboxCommandReceipt;
	readonly identity: CloudMailboxCommandIdentity;
	readonly payload: CloudMessageSendPayload;
	readonly receipts: CloudMailboxReceiptStore;
}) {
	if (receiptConflict(input.receipt, input.identity))
		return yield* Effect.fail(
			rejectCloudMailboxCommand("runtime-receipt-conflict"),
		);
	if (!receiptProvesDurableMessage(input.receipt, input.payload))
		return yield* Effect.fail(
			rejectCloudMailboxCommand("runtime-receipt-invalid"),
		);
	if (receiptIsDurableAndBound(input.receipt, input.identity, input.payload))
		return;

	// Matching legacy v2 receipts predate the identity columns. Binding is a CAS:
	// a concurrent incompatible claimant cannot overwrite any populated field.
	yield* input.receipts.bindIdentity(input.identity);
	const bound = yield* input.receipts.read(input.identity.commandId);
	if (
		bound === null ||
		!receiptIsDurableAndBound(bound, input.identity, input.payload)
	)
		return yield* Effect.fail(
			rejectCloudMailboxCommand("runtime-receipt-invalid"),
		);
});

const messageFailureCategory = (error: {
	readonly _tag?: string;
}): CloudMailboxCommandRejectionCategory => {
	if (error._tag === "SessionNotFoundError") return "session-not-found";
	if (error._tag === "DirectoryUnavailableError")
		return "workspace-directory-unavailable";
	return "runtime-apply-failed";
};

const rejectionCategoryFromCause = (
	cause: Cause.Cause<CloudMailboxApplyError>,
): CloudMailboxCommandRejectionCategory => {
	const error = Cause.findErrorOption(cause);
	if (
		Option.isSome(error) &&
		typeof error.value === "object" &&
		error.value !== null &&
		"_tag" in error.value &&
		error.value._tag === "CloudMailboxApplyError"
	)
		return (error.value as CloudMailboxApplyError).category;
	return "runtime-apply-failed";
};

export const applyCloudMailboxLease = Effect.fn(
	"CloudWorkspaceRuntime.applyMailboxLease",
)(function* (input: {
	readonly config: Pick<CloudWorkspaceRuntimeConfig, "workspaceId">;
	readonly lease: typeof RuntimeLease.Type;
	readonly runtimeGeneration: number;
	readonly providerSandboxId: string;
	readonly nowMs: Effect.Effect<number>;
	readonly transcriptKey: string;
	readonly storageIncarnationId: string;
	readonly sendMessage: MessageService["Service"]["sendMessage"];
	readonly receipts: CloudMailboxReceiptStore;
}) {
	const { command: envelope } = input.lease;
	const applied = Effect.gen(function* () {
		if (input.lease.runtimeGeneration !== input.runtimeGeneration)
			return yield* Effect.fail(
				rejectCloudMailboxCommand("runtime-generation-mismatch"),
			);
		if (input.lease.providerSandboxId !== input.providerSandboxId)
			return yield* Effect.fail(
				rejectCloudMailboxCommand("runtime-provider-sandbox-mismatch"),
			);
		if (input.lease.storageIncarnationId !== input.storageIncarnationId)
			return yield* Effect.fail(
				rejectCloudMailboxCommand("runtime-storage-incarnation-mismatch"),
			);
		if (envelope.workspaceId !== input.config.workspaceId)
			return yield* Effect.fail(
				rejectCloudMailboxCommand("command-payload-identity-mismatch"),
			);
		const eligibility = cloudCommandEligibility(envelope.kind);
		if (eligibility === undefined)
			return yield* Effect.fail(
				rejectCloudMailboxCommand("command-kind-not-supported"),
			);
		if (eligibility.dependencies !== "none" || envelope.dependencies.length > 0)
			return yield* Effect.fail(
				rejectCloudMailboxCommand("command-dependencies-not-supported"),
			);
		if (envelope.schemaVersion !== eligibility.schemaVersion)
			return yield* Effect.fail(
				rejectCloudMailboxCommand("command-schema-not-supported"),
			);
		// Eligibility is shared rollout policy; this guard is the runtime's
		// executable handler dispatch and remains closed to newly registered kinds.
		if (envelope.kind !== "messages.send")
			return yield* Effect.fail(
				rejectCloudMailboxCommand("command-kind-not-supported"),
			);

		const aad = cloudCommandAdditionalData(envelope);
		const plaintext = yield* Effect.tryPromise({
			try: () =>
				decryptCloudCommandBody({
					encodedKey: input.transcriptKey,
					additionalData: aad,
					iv: envelope.iv,
					ciphertext: envelope.ciphertext,
				}),
			catch: () => rejectCloudMailboxCommand("command-decryption-failed"),
		});
		if (plaintext.byteLength > eligibility.maxPlaintextBytes)
			return yield* Effect.fail(
				rejectCloudMailboxCommand("command-payload-too-large"),
			);
		const fingerprint = yield* Effect.tryPromise({
			try: () =>
				keyedCloudCommandFingerprint({
					encodedKey: input.transcriptKey,
					canonicalPlaintext: plaintext,
				}),
			catch: () => rejectCloudMailboxCommand("command-decryption-failed"),
		});
		if (fingerprint !== envelope.fingerprint)
			return yield* Effect.fail(
				rejectCloudMailboxCommand("command-fingerprint-mismatch"),
			);
		const decodedPayload = yield* Effect.try({
			try: () => JSON.parse(new TextDecoder().decode(plaintext)) as unknown,
			catch: () => rejectCloudMailboxCommand("command-payload-invalid"),
		});
		const payload = decodeCloudMessageSendPayload(decodedPayload);
		if (payload === null)
			return yield* Effect.fail(
				rejectCloudMailboxCommand("command-payload-invalid"),
			);
		if (
			payload.commandId !== envelope.commandId ||
			payload.sessionId !== envelope.sessionId
		)
			return yield* Effect.fail(
				rejectCloudMailboxCommand("command-payload-identity-mismatch"),
			);
		const limitation = cloudMessageSendPayloadLimitation(payload);
		if (limitation !== null) {
			const category =
				limitation === "attachments-not-supported"
					? "command-dependencies-not-supported"
					: "command-goal-mode-not-supported";
			return yield* Effect.fail(rejectCloudMailboxCommand(category));
		}
		const composer = payload.input;
		// Prepare the terminal result before crossing the apply boundary. Once the
		// domain receipt exists, a local encryption failure must not turn an applied
		// provider workflow into a false `rejected` terminal outcome.
		const encryptedResult = yield* Effect.tryPromise({
			try: () =>
				encryptCloudCommandBody({
					encodedKey: input.transcriptKey,
					additionalData: aad,
					plaintext: new TextEncoder().encode(
						JSON.stringify({
							commandId: envelope.commandId,
							result: null,
						} satisfies CloudMessageSendResult),
					),
				}),
			catch: () => rejectCloudMailboxCommand("result-encryption-failed"),
		});
		const receiptIdentity = {
			commandId: envelope.commandId,
			streamId: envelope.sessionId,
			fingerprint: envelope.fingerprint,
			commandKind: envelope.kind,
			schemaVersion: envelope.schemaVersion,
			storageIncarnationId: input.storageIncarnationId,
		} satisfies CloudMailboxCommandIdentity;
		const existing = yield* input.receipts.read(envelope.commandId);
		if (existing !== null) {
			yield* verifyAndBindCloudMailboxReceipt({
				receipt: existing,
				identity: receiptIdentity,
				payload,
				receipts: input.receipts,
			});
			// The authoritative SQLite receipt proves this exact encrypted command
			// already applied. Startup reactor recovery owns any downstream catch-up;
			// do not re-enter MessageService or the provider from mailbox replay.
			return encryptedResult;
		}
		if ((yield* input.nowMs) >= input.lease.leaseDeadline)
			return yield* Effect.fail(
				rejectCloudMailboxCommand("runtime-lease-expired"),
			);

		const domainReceiptIdentity = {
			fingerprint: receiptIdentity.fingerprint,
			commandKind: receiptIdentity.commandKind,
			schemaVersion: receiptIdentity.schemaVersion,
			storageIncarnationId: receiptIdentity.storageIncarnationId,
		} satisfies CommandReceiptIdentity;
		const sendOutcome = yield* input
			.sendMessage(
				envelope.commandId,
				payload.sessionId,
				composer?.text ?? payload.text ?? "",
				composer?.attachments,
				composer?.fileRefs,
				composer?.skillRefs,
				composer?.annotations,
				false,
				payload.clientMessageId,
				undefined,
				domainReceiptIdentity,
			)
			.pipe(
				Effect.mapError((error) =>
					rejectCloudMailboxCommand(messageFailureCategory(error)),
				),
				Effect.exit,
			);
		const receipt = yield* input.receipts.read(envelope.commandId);
		if (receipt !== null) {
			yield* verifyAndBindCloudMailboxReceipt({
				receipt,
				identity: receiptIdentity,
				payload,
				receipts: input.receipts,
			});
			return encryptedResult;
		}
		if (sendOutcome._tag === "Failure")
			return yield* Effect.failCause(sendOutcome.cause);
		return yield* Effect.fail(
			rejectCloudMailboxCommand("runtime-receipt-missing"),
		);
	});

	const outcome = yield* Effect.exit(applied);
	if (outcome._tag === "Success")
		return RuntimeAcknowledgment.make({
			commandId: envelope.commandId,
			leaseToken: input.lease.leaseToken,
			fingerprint: envelope.fingerprint,
			state: "applied",
			resultIv: outcome.value.iv,
			resultCiphertext: outcome.value.ciphertext,
		});
	const category = rejectionCategoryFromCause(outcome.cause);
	const retryWithoutAcknowledgment =
		category === "runtime-receipt-store-unavailable" ||
		category === "runtime-lease-expired";
	if (retryWithoutAcknowledgment) return null;
	const outcomeIsUnknown =
		category === "runtime-receipt-missing" ||
		category === "runtime-receipt-invalid" ||
		category === "runtime-apply-failed";
	return RuntimeAcknowledgment.make({
		commandId: envelope.commandId,
		leaseToken: input.lease.leaseToken,
		fingerprint: envelope.fingerprint,
		state: outcomeIsUnknown ? "outcome-unknown" : "rejected",
		category,
	});
});

export const classifyCloudMailboxAckFailure = (
	error: CloudWorkspaceRuntimeError,
): "retry" | "stop-retrying" => {
	if (
		error.reason === "api_request_failed" ||
		error.reason === "api_invalid_response"
	)
		return "retry";
	const status = error.httpStatus;
	// Each retry builds a new request from the mutable credential state, so a 401
	// can be the response from the token that raced a successful renewal. The
	// credential supervisor terminates the process if renewal itself is fenced.
	if (
		status === 401 ||
		status === 408 ||
		status === 425 ||
		status === 429 ||
		(status !== undefined && status >= 500 && status <= 599)
	)
		return "retry";
	return "stop-retrying";
};

export interface CloudMailboxConsumerState {
	readonly pendingApplications: Map<string, typeof RuntimeLease.Type>;
	readonly pendingAcknowledgments: Map<
		string,
		typeof RuntimeAcknowledgment.Type
	>;
}

export const runCloudMailboxConsumerCycle = Effect.fn(
	"CloudWorkspaceRuntime.runMailboxConsumerCycle",
)(function* (input: {
	readonly state: CloudMailboxConsumerState;
	readonly lease: Effect.Effect<
		Readonly<{
			leases: ReadonlyArray<typeof RuntimeLease.Type>;
			fenceRequired?: boolean;
		}>,
		CloudWorkspaceRuntimeError
	>;
	readonly apply: (
		lease: typeof RuntimeLease.Type,
	) => Effect.Effect<typeof RuntimeAcknowledgment.Type | null>;
	readonly acknowledge: (
		acknowledgment: typeof RuntimeAcknowledgment.Type,
	) => Effect.Effect<unknown, CloudWorkspaceRuntimeError>;
	readonly onRuntimeFenceRequired?: Effect.Effect<void>;
}) {
	let runtimeFenceRequested = false;
	const requestRuntimeFence = Effect.suspend(() => {
		if (runtimeFenceRequested) return Effect.void;
		runtimeFenceRequested = true;
		return input.onRuntimeFenceRequired ?? Effect.void;
	});
	const acknowledge = Effect.fn(
		"CloudWorkspaceRuntime.acknowledgeMailboxCommand",
	)(function* (acknowledgment: typeof RuntimeAcknowledgment.Type) {
		const result = yield* input.acknowledge(acknowledgment).pipe(Effect.result);
		if (result._tag === "Success") {
			input.state.pendingAcknowledgments.delete(acknowledgment.commandId);
			return;
		}
		const disposition = classifyCloudMailboxAckFailure(result.failure);
		const metadata = {
			commandId: acknowledgment.commandId,
			reason: result.failure.reason,
			httpStatus: result.failure.httpStatus,
			disposition,
		};
		if (disposition === "stop-retrying") {
			yield* Effect.logError(
				"cloud mailbox permanent acknowledgment failure",
				metadata,
			);
			input.state.pendingAcknowledgments.delete(acknowledgment.commandId);
			// The mailbox reserves 409 for an impossible fingerprint/token
			// invariant. Terminate the production runtime so the control plane can
			// fence its generation instead of stranding the lane. The injected test
			// hook returns normally, proving a permanent ACK never blocks polling.
			if (result.failure.httpStatus === 409) yield* requestRuntimeFence;
			return;
		}
		yield* Effect.logWarning(
			"cloud mailbox acknowledgment temporarily failed",
			metadata,
		);
	});

	for (const acknowledgment of [...input.state.pendingAcknowledgments.values()])
		yield* acknowledge(acknowledgment);

	const apply = Effect.fn("CloudWorkspaceRuntime.applyPendingMailboxCommand")(
		function* (lease: typeof RuntimeLease.Type) {
			const acknowledgment = yield* input.apply(lease);
			if (acknowledgment === null) {
				if ((yield* Clock.currentTimeMillis) >= lease.leaseDeadline) {
					input.state.pendingApplications.delete(lease.command.commandId);
					// The DO will not re-lease an uncertain command until this runtime
					// generation is provably fenced. Recycle now instead of leaving the
					// session lane parked in lease-expired-awaiting-fence indefinitely.
					yield* requestRuntimeFence;
				}
				return;
			}
			input.state.pendingApplications.delete(lease.command.commandId);
			input.state.pendingAcknowledgments.set(
				acknowledgment.commandId,
				acknowledgment,
			);
			yield* acknowledge(acknowledgment);
		},
	);
	for (const lease of [...input.state.pendingApplications.values()])
		yield* apply(lease);

	const leasePage = yield* input.lease;
	if (leasePage.fenceRequired) {
		// A process restart can forget the expired lease held by its previous
		// incarnation while retaining the same control-plane generation. The
		// mailbox refuses to replay until that generation is fenced; honor the
		// explicit signal instead of silently polling an empty page forever.
		yield* requestRuntimeFence;
		return;
	}
	for (const lease of leasePage.leases) {
		if (input.state.pendingApplications.has(lease.command.commandId)) continue;
		input.state.pendingApplications.set(lease.command.commandId, lease);
		yield* apply(lease);
	}
});

const runCloudMailboxConsumer = (input: {
	readonly config: CloudWorkspaceRuntimeConfig;
	readonly runtimeCredential: RuntimeCredentialState;
	readonly providerSandboxId: string;
	readonly transcriptKey: string;
	readonly storageIncarnationId: string;
	readonly messages: MessageService["Service"];
	readonly sql: SqlClient.SqlClient;
}): Effect.Effect<never, never> => {
	const state: CloudMailboxConsumerState = {
		pendingApplications: new Map(),
		pendingAcknowledgments: new Map(),
	};
	const receipts = makeCloudMailboxReceiptStore(input.sql);
	const poll = runCloudMailboxConsumerCycle({
		state,
		lease: Effect.suspend(() =>
			requestJson({
				schema: RuntimeLeasePage,
				url: `${input.config.apiUrl}${ApiPaths.cloudWorkspaceRuntimeCommandLease(input.config.workspaceId)}`,
				token: input.runtimeCredential.credential,
				method: "POST",
				body: { storageIncarnationId: input.storageIncarnationId },
				timeoutMs: 10_000,
			}),
		),
		apply: (lease) =>
			applyCloudMailboxLease({
				config: input.config,
				lease,
				runtimeGeneration: input.runtimeCredential.generation,
				providerSandboxId: input.providerSandboxId,
				nowMs: Clock.currentTimeMillis,
				transcriptKey: input.transcriptKey,
				storageIncarnationId: input.storageIncarnationId,
				sendMessage: input.messages.sendMessage,
				receipts,
			}),
		acknowledge: (acknowledgment) =>
			requestJson({
				schema: Schema.Unknown,
				url: `${input.config.apiUrl}${ApiPaths.cloudWorkspaceRuntimeCommandAck(input.config.workspaceId)}`,
				token: input.runtimeCredential.credential,
				method: "POST",
				body: acknowledgment,
				timeoutMs: 10_000,
			}),
		onRuntimeFenceRequired: Effect.sync(() => {
			process.kill(process.pid, "SIGTERM");
		}),
	}).pipe(
		Effect.catch((error) =>
			Effect.logWarning("cloud mailbox poll failed", { reason: error.reason }),
		),
		Effect.delay("1 second"),
	);
	return poll.pipe(Effect.forever);
};

const postReady = (
	config: CloudWorkspaceRuntimeConfig,
	runtimeCredential: string,
	phase: "repository-ready" | "agent-started" | "launch-failed",
	launchCommandId?: string,
	errorCode?: string,
	sessionHeadVersion?: number,
): Effect.Effect<void, CloudWorkspaceRuntimeError> =>
	requestJson({
		schema: Schema.Unknown,
		url: `${config.apiUrl}${ApiPaths.cloudWorkspaceReady(config.workspaceId)}`,
		token: runtimeCredential,
		method: "POST",
		body: {
			phase,
			launchCommandId,
			errorCode,
			sessionHeadVersion,
			...(phase === "repository-ready"
				? { commandProtocolVersion: CLOUD_COMMAND_PROTOCOL_VERSION }
				: {}),
		},
	}).pipe(Effect.asVoid);

const writeCredentialsReady = Effect.tryPromise({
	try: async () => {
		await mkdir(dirname(CREDENTIALS_READY_MARKER), {
			recursive: true,
			mode: 0o700,
		});
		await writeFile(CREDENTIALS_READY_MARKER, "ready\n", { mode: 0o600 });
		await writeFile(CREDENTIALS_READY_EVENT, "ready\n");
	},
	catch: () => fail("workspace_credentials_ready_failed"),
});

const waitForRepository = Effect.callback<void, CloudWorkspaceRuntimeError>(
	(resume) => {
		let settled = false;
		const finish = (
			effect: Effect.Effect<void, CloudWorkspaceRuntimeError>,
		) => {
			if (settled) return;
			settled = true;
			watcher.close();
			resume(effect);
		};
		const check = () => {
			void access(REPOSITORY_READY_MARKER).then(
				() => finish(Effect.void),
				() => undefined,
			);
		};
		const watcher = watch(
			dirname(REPOSITORY_READY_MARKER),
			(event, filename) => {
				if (event === "rename" && filename === "repository-ready") check();
			},
		);
		watcher.once("error", () =>
			finish(Effect.fail(fail("workspace_repository_ready_failed"))),
		);
		check();
		return Effect.sync(() => {
			settled = true;
			watcher.close();
		});
	},
);

const removeBootToken = (path: string | undefined) =>
	path === undefined
		? Effect.void
		: Effect.tryPromise({
				try: () => unlink(path),
				catch: () => fail("workspace_boot_token_cleanup_failed"),
			}).pipe(Effect.ignore);

export const startCloudWorkspaceLaunchIntent = (input: {
	readonly workspaces: WorkspaceServiceShape;
	readonly chats: ChatServiceShape;
	readonly chatId: string;
	readonly sessionId: string;
	readonly workspaceRoot: string;
	readonly launchIntent: Exclude<
		typeof BootstrapResponse.Type.launchIntent,
		undefined
	>;
}) =>
	Effect.gen(function* () {
		const provider = Schema.decodeUnknownOption(ProviderId)(
			input.launchIntent.agent,
		);
		if (provider._tag === "None" || input.launchIntent.model.length === 0)
			return yield* Effect.fail(fail("workspace_agent_config_invalid"));
		const folders = yield* input.workspaces.list();
		const folder =
			folders.find((candidate) => candidate.path === input.workspaceRoot) ??
			(yield* input.workspaces
				.add(input.workspaceRoot)
				.pipe(Effect.mapError(() => fail("workspace_registration_failed"))));
		const title = input.launchIntent.pendingRename ?? input.launchIntent.title;
		const commandId = input.launchIntent.commandId;
		yield* input.chats
			.createChat({
				chatId: ChatId.make(input.chatId),
				initialSessionId: AgentSessionId.make(input.sessionId),
				commandId,
				initialTurnId: AgentTurnId.make(input.launchIntent.turnId),
				initialMessageId: MessageId.make(`${commandId}:message`),
				projectId: FolderId.make(folder.id),
				title,
				providerId: provider.value,
				model: input.launchIntent.model,
				runtimeMode: input.launchIntent.runtimeMode ?? DEFAULT_RUNTIME_MODE,
				initialPrompt: input.launchIntent.firstMessage,
				background: false,
			})
			.pipe(Effect.mapError(() => fail("workspace_agent_start_failed")));
	});

export const cloudGatewayCloseReason = (code: number): string => {
	if (code === WORKSPACE_GATEWAY_STALE_GENERATION_CLOSE.code)
		return "workspace_gateway_generation_changed";
	if (code === WORKSPACE_GATEWAY_AUTH_EXPIRED_CLOSE.code)
		return "workspace_gateway_authorization_expired";
	if (code === WORKSPACE_GATEWAY_UPDATE_REQUIRED_CLOSE.code)
		return "workspace_gateway_update_required";
	return "workspace_gateway_disconnected";
};

const retryableCloudGatewayFailure = (
	error: CloudWorkspaceRuntimeError,
): boolean =>
	error.reason === "workspace_gateway_unreachable" ||
	error.reason === "workspace_gateway_disconnected";

const websocketClosed = (
	url: string,
	protocols: () => ReadonlyArray<string>,
	onSocket: (socket: WebSocket) => void,
): Effect.Effect<void, CloudWorkspaceRuntimeError> =>
	Effect.callback<void, CloudWorkspaceRuntimeError>((resume) => {
		let settled = false;
		const finish = (
			effect: Effect.Effect<void, CloudWorkspaceRuntimeError>,
		) => {
			if (settled) return;
			settled = true;
			resume(effect);
		};
		const socket = new WebSocket(url, [...protocols()]);
		socket.binaryType = "arraybuffer";
		socket.addEventListener("open", () => onSocket(socket), { once: true });
		socket.addEventListener(
			"error",
			(event) => {
				console.error("[cloud-workspace-runtime] gateway connection failed", {
					type: event.type,
				});
				finish(Effect.fail(fail("workspace_gateway_unreachable")));
			},
			{ once: true },
		);
		socket.addEventListener(
			"close",
			(event) => finish(Effect.fail(fail(cloudGatewayCloseReason(event.code)))),
			{ once: true },
		);
		return Effect.sync(() => socket.close());
	});

/**
 * Cloud-only runtime link. The workspace runtime owns all chat state and keeps
 * consuming providers independently of client sockets. API is used only for
 * bootstrap/auth/lifecycle and as an opaque hibernatable WebSocket router.
 */
export const makeCloudWorkspaceRuntimeLayer = (
	config: CloudWorkspaceRuntimeConfig | undefined,
): Layer.Layer<
	never,
	CloudWorkspaceRuntimeError,
	| LanAuthService
	| WorkspaceService
	| ChatService
	| MessageService
	| CredentialsService
	| SessionDomain
	| SqlClient.SqlClient
> =>
	config === undefined
		? Layer.empty
		: Layer.effectDiscard(
				Effect.gen(function* () {
					const auth = yield* LanAuthService;
					const workspaces = yield* WorkspaceService;
					const chats = yield* ChatService;
					const messages = yield* MessageService;
					const sql = yield* SqlClient.SqlClient;
					const credentials = yield* CredentialsService;
					yield* installImageProviderSecrets(credentials);
					const sessionDomain = yield* SessionDomain;
					const storageIncarnationId = yield* cloudStorageIncarnationId.pipe(
						Effect.mapError(() =>
							fail("workspace_storage_incarnation_unavailable"),
						),
					);
					const [credentialKeyPair, signingKeyPair] = yield* Effect.tryPromise({
						try: () =>
							Promise.all([
								generateKeyPair("RSA-OAEP-256", { extractable: true }),
								generateKeyPair("EdDSA", { extractable: true }),
							]),
						catch: () => fail("workspace_credential_key_failed"),
					});
					const [credentialPublicJwk, signingPublicJwk] =
						yield* Effect.tryPromise({
							try: async () =>
								Promise.all([
									JSON.stringify(await exportJWK(credentialKeyPair.publicKey)),
									JSON.stringify(await exportJWK(signingKeyPair.publicKey)),
								]),
							catch: () => fail("workspace_credential_key_failed"),
						});
					const bootstrap = yield* retryCloudWorkspaceBootstrap(
						requestJson({
							schema: BootstrapResponse,
							url: `${config.apiUrl}${ApiPaths.cloudWorkspaceBootstrap(config.workspaceId)}`,
							token: Redacted.value(config.bootToken),
							method: "POST",
							body: { credentialPublicJwk, signingPublicJwk },
						}),
					);
					const runtimeCredential: RuntimeCredentialState = {
						credential: bootstrap.runtimeCredential,
						gatewayCredential: bootstrap.runtimeGatewayCredential,
						expiresAt: bootstrap.runtimeCredentialExpiresAt,
						generation: bootstrap.runtimeGeneration,
						gatewayEpoch: bootstrap.gatewayEpoch,
					};
					const postCurrentRuntimeReady = (
						phase: "repository-ready" | "agent-started" | "launch-failed",
						launchCommandId?: string,
						errorCode?: string,
						sessionHeadVersion?: number,
					) =>
						Effect.suspend(() =>
							postReady(
								config,
								runtimeCredential.credential,
								phase,
								launchCommandId,
								errorCode,
								sessionHeadVersion,
							),
						);
					yield* writeGithubBrokerState(config, runtimeCredential.credential);
					yield* superviseRuntimeCredential({
						config,
						signingPrivateKey: signingKeyPair.privateKey,
						state: runtimeCredential,
					}).pipe(Effect.forkScoped({ startImmediately: true }));
					const transcriptKey = yield* Effect.tryPromise({
						try: async () => {
							const decrypted = await compactDecrypt(
								bootstrap.sealedTranscriptKey,
								credentialKeyPair.privateKey,
							);
							return new TextDecoder().decode(decrypted.plaintext);
						},
						catch: () => fail("workspace_transcript_key_decryption_failed"),
					});
					if (bootstrap.sealedProviderGrant !== undefined) {
						const grant = yield* decryptProviderGrant(
							bootstrap.sealedProviderGrant,
							credentialKeyPair.privateKey,
						);
						if (
							grant.workspaceId !== config.workspaceId ||
							grant.runtimeGeneration !== bootstrap.runtimeGeneration
						)
							return yield* Effect.fail(
								fail("workspace_provider_grant_fence_mismatch"),
							);
						const secret =
							grant.env.ANTHROPIC_API_KEY ??
							grant.env.CLAUDE_CODE_OAUTH_TOKEN ??
							grant.env.OPENAI_API_KEY ??
							grant.env.CURSOR_API_KEY ??
							grant.env.GROK_CODE_XAI_API_KEY ??
							grant.env.XAI_API_KEY;
						if (secret === undefined || secret.length < 8)
							return yield* Effect.fail(
								fail("workspace_provider_grant_invalid"),
							);
						yield* ensureProviderCredential(credentials, {
							providerId: grant.providerId,
							kind:
								grant.providerId === "claude" && grant.method === "subscription"
									? "oauth-token"
									: "api-key",
							secret,
						});
					}
					yield* writeCredentialsReady;
					console.info("[cloud-workspace-runtime] credentials ready");
					const acknowledgeBootstrap = retryCloudWorkspaceBootstrap(
						Effect.suspend(() =>
							requestJson({
								schema: RuntimeBootstrapAckResponse,
								url: `${config.apiUrl}${ApiPaths.cloudWorkspaceBootstrapAck(config.workspaceId)}`,
								token: runtimeCredential.credential,
								method: "POST",
								body: {
									runtimeGeneration: runtimeCredential.generation,
									gatewayEpoch: runtimeCredential.gatewayEpoch,
								},
							}),
						),
					).pipe(Effect.andThen(removeBootToken(config.bootTokenFile)));
					const localCredential = yield* auth
						.mintToken("cloud workspace gateway")
						.pipe(
							Effect.mapError(() => fail("workspace_local_rpc_auth_failed")),
						);
					console.info("[cloud-workspace-runtime] local rpc auth ready");

					const readRuntimeSummary = Effect.gen(function* () {
						const [chat, sessionHeadVersion, lastActivityAt] =
							yield* Effect.all(
								[
									chats
										.getChat(ChatId.make(bootstrap.chatId))
										.pipe(
											Effect.mapError(() =>
												fail("workspace_summary_chat_unavailable"),
											),
										),
									sessionDomain
										.currentStreamVersion(bootstrap.initialSessionId)
										.pipe(
											Effect.mapError(() =>
												fail("workspace_summary_head_unavailable"),
											),
										),
									Clock.currentTimeMillis,
								],
								{ concurrency: "unbounded" },
							);
						return { title: chat.title, lastActivityAt, sessionHeadVersion };
					});
					const summaryPublisher = yield* makeCloudRuntimeSummaryPublisher({
						now: Clock.currentTimeMillis,
						read: readRuntimeSummary,
						write: (summary) =>
							requestJson({
								schema: RuntimeSummaryResponse,
								url: `${config.apiUrl}${ApiPaths.cloudWorkspaceSummary(config.workspaceId)}`,
								token: runtimeCredential.credential,
								method: "POST",
								body: summary,
							}).pipe(
								Effect.mapError(() => fail("workspace_summary_publish_failed")),
							),
					});
					const checkpointPublishers = new Map<
						string,
						CloudRuntimeCheckpointPublisher
					>();
					const checkpointPublisherFor = Effect.fn(
						"CloudWorkspaceRuntime.checkpointPublisherFor",
					)(function* (sessionId: string) {
						const existing = checkpointPublishers.get(sessionId);
						if (existing !== undefined) return existing;
						const publisher = yield* makeCloudRuntimeCheckpointPublisher({
							workspaceId: config.workspaceId,
							sessionId,
							transcriptKey,
							read: Effect.gen(function* () {
								const [snapshot, version] = yield* Effect.all(
									[
										sessionDomain.timelineSnapshot(
											AgentSessionId.make(sessionId),
										),
										sessionDomain.currentStreamVersion(sessionId),
									],
									{ concurrency: "unbounded" },
								).pipe(
									Effect.mapError(() =>
										fail("workspace_transcript_snapshot_unavailable"),
									),
								);
								return {
									cursor: { epoch: sessionDomain.streamEpoch, version },
									projection: snapshot.projection,
								};
							}),
							readPage: (beforeSequence) =>
								sessionDomain
									.timelineMessagePage(
										AgentSessionId.make(sessionId),
										beforeSequence,
										100,
									)
									.pipe(
										Effect.map((page) => ({
											messages: page.items.map((item) => item.message),
											olderMessageSequence: page.olderMessageSequence,
										})),
										Effect.mapError(() =>
											fail("workspace_transcript_page_unavailable"),
										),
									),
							write: (checkpoint) =>
								requestJson({
									schema: RuntimeTranscriptCheckpointResponse,
									url: `${config.apiUrl}${ApiPaths.cloudWorkspaceRuntimeTranscriptCheckpoint(config.workspaceId)}`,
									token: runtimeCredential.credential,
									method: "POST",
									body: { sessionId, ...checkpoint },
								}).pipe(
									Effect.tap((response) =>
										response.archiveRequested
											? messages
													.interruptSession(
														`archive:${config.workspaceId}:${sessionId}`,
														SessionId.make(sessionId),
													)
													.pipe(Effect.ignore)
											: Effect.void,
									),
									Effect.asVoid,
								),
							writePage: (page) =>
								requestJson({
									schema: RuntimeTranscriptMessagePageResponse,
									url: `${config.apiUrl}${ApiPaths.cloudWorkspaceRuntimeTranscriptMessagePage(config.workspaceId)}`,
									token: runtimeCredential.credential,
									method: "POST",
									body: { sessionId, ...page },
								}).pipe(
									Effect.mapError(() =>
										fail("workspace_transcript_page_publish_failed"),
									),
									Effect.asVoid,
								),
						});
						checkpointPublishers.set(sessionId, publisher);
						yield* Effect.forever(
							publisher.flush.pipe(
								Effect.retry(cloudRuntimeRetrySchedule),
								Effect.ignore,
								Effect.andThen(Effect.sleep("1 second")),
							),
						).pipe(Effect.forkScoped({ startImmediately: true }));
						return publisher;
					});
					const publishActivity = () => {
						void Effect.runPromise(
							summaryPublisher.publish("activity").pipe(Effect.ignore),
						);
					};
					const localSockets = new Map<string, WebSocket>();
					const pendingLocalFrames = new Map<
						string,
						WorkspaceLocalFrameQueue
					>();
					let gateway: WebSocket | null = null;
					let repositoryReady = false;
					const sendGateway = (message: unknown) => {
						if (gateway?.readyState === WebSocket.OPEN)
							gateway.send(
								typeof message === "string" || message instanceof ArrayBuffer
									? message
									: JSON.stringify(message),
							);
					};
					const openLocal = (connectionId: string) => {
						if (localSockets.has(connectionId)) return;
						pendingLocalFrames.set(connectionId, { frames: [], bytes: 0 });
						const url = new URL(`ws://127.0.0.1:${config.localPort}`);
						url.searchParams.set("token", localCredential.token);
						url.searchParams.set("wireVersion", String(WIRE_PROTOCOL_VERSION));
						const socket = new WebSocket(url);
						socket.binaryType = "arraybuffer";
						localSockets.set(connectionId, socket);
						socket.addEventListener(
							"open",
							() => {
								if (localSockets.get(connectionId) !== socket) return;
								const pending = pendingLocalFrames.get(connectionId);
								pendingLocalFrames.delete(connectionId);
								if (pending === undefined) return;
								for (const payload of pending.frames) socket.send(payload);
							},
							{ once: true },
						);
						socket.addEventListener("message", (event) => {
							publishActivity();
							if (
								typeof event.data === "string" ||
								event.data instanceof ArrayBuffer ||
								ArrayBuffer.isView(event.data)
							) {
								try {
									sendGateway(
										encodeWorkspaceGatewayFrame({
											direction: "runtime",
											connectionId,
											payload:
												typeof event.data === "string"
													? event.data
													: workspaceGatewayArrayBuffer(event.data),
										}),
									);
								} catch {
									socket.close(1009, "local RPC frame too large");
								}
							}
						});
						socket.addEventListener("close", () => {
							// Only the socket still owned by this connection may tear the
							// route down. A delayed close from a replaced local socket must
							// not terminate its successor.
							if (localSockets.get(connectionId) !== socket) return;
							localSockets.delete(connectionId);
							pendingLocalFrames.delete(connectionId);
							// The gateway deliberately has no replay buffer. Closing the
							// disposable client makes its one supervisor reconnect and
							// resume every retained resource from a durable cursor.
							sendGateway({ type: "client.close", connectionId });
						});
					};

					console.info("[cloud-workspace-runtime] connecting gateway");
					const connectGateway = websocketClosed(
						bootstrap.gatewayUrl,
						() => [
							bootstrap.gatewayProtocol,
							runtimeCredential.gatewayCredential ??
								runtimeCredential.credential,
						],
						(socket) => {
							gateway = socket;
							const reconnectPhase =
								runtimeReadyPhaseOnGatewayOpen(repositoryReady);
							if (reconnectPhase !== null)
								void Effect.runPromise(
									postCurrentRuntimeReady(reconnectPhase).pipe(Effect.ignore),
								);
							socket.addEventListener("message", (event) => {
								if (
									event.data instanceof ArrayBuffer ||
									ArrayBuffer.isView(event.data)
								) {
									const frame = decodeWorkspaceGatewayFrame(
										workspaceGatewayArrayBuffer(event.data),
									);
									if (frame?.direction !== "client") return;
									publishActivity();
									const local = localSockets.get(frame.connectionId);
									const pending = pendingLocalFrames.get(frame.connectionId);
									// No frame buffer lives in the gateway. The runtime holds only
									// the bounded localhost-open handoff for this connection.
									if (local?.readyState === WebSocket.OPEN) {
										local.send(frame.payload);
									} else if (
										local?.readyState === WebSocket.CONNECTING &&
										pending !== undefined &&
										bufferWorkspaceLocalFrame(pending, frame.payload)
									) {
										// The localhost socket will flush this frame in order on OPEN.
									} else {
										local?.close(1013, "local runtime synchronizing");
										localSockets.delete(frame.connectionId);
										pendingLocalFrames.delete(frame.connectionId);
										sendGateway({
											type: "client.close",
											connectionId: frame.connectionId,
										});
									}
									return;
								}
								if (typeof event.data !== "string") return;
								let message: Record<string, unknown>;
								try {
									message = JSON.parse(event.data) as Record<string, unknown>;
								} catch {
									return;
								}
								if (
									message.type === "client.open" &&
									typeof message.connectionId === "string"
								)
									openLocal(message.connectionId);
								if (
									message.type === "client.close" &&
									typeof message.connectionId === "string"
								) {
									localSockets.get(message.connectionId)?.close();
									localSockets.delete(message.connectionId);
									pendingLocalFrames.delete(message.connectionId);
								}
							});
						},
					).pipe(
						Effect.retry({
							while: retryableCloudGatewayFailure,
							schedule: cloudRuntimeRetrySchedule,
						}),
						Effect.ensuring(
							Effect.sync(() => {
								gateway = null;
								for (const socket of localSockets.values()) socket.close();
								localSockets.clear();
								pendingLocalFrames.clear();
							}),
						),
					);
					yield* connectGateway.pipe(
						Effect.forkScoped({ startImmediately: true }),
					);

					// Durable commands depend on the repository and runtime credential,
					// not on the disposable UI gateway. A gateway outage must never stop
					// this runtime from draining its workspace mailbox.
					yield* waitForRepository;
					// Record the local prerequisite first. If the gateway opens while the
					// control-plane update is in flight, its callback publishes another
					// ready revision after the socket is actually usable.
					repositoryReady = true;
					yield* postCurrentRuntimeReady("repository-ready").pipe(
						Effect.retry(cloudRuntimeRetrySchedule),
					);
					yield* runCloudMailboxConsumer({
						config,
						runtimeCredential,
						providerSandboxId: bootstrap.providerSandboxId,
						transcriptKey,
						storageIncarnationId,
						messages,
						sql,
					}).pipe(Effect.forkScoped({ startImmediately: true }));
					yield* acknowledgeBootstrap.pipe(
						Effect.forkScoped({ startImmediately: true }),
					);

					// Transcript and summary maintenance are not prerequisites for a usable
					// sandbox. Start them after the worktree is ready so they never extend
					// workspace setup latency.
					yield* checkpointPublisherFor(bootstrap.initialSessionId);
					const sessionEventCursor = yield* sessionDomain.currentSequence.pipe(
						Effect.mapError(() => fail("workspace_summary_cursor_unavailable")),
					);
					yield* sessionDomain
						.allEvents({ afterSequence: sessionEventCursor })
						.pipe(
							Stream.runForEach((record) =>
								Effect.gen(function* () {
									const reason: RuntimeSummaryReason | null =
										record.event._tag === "SessionTitleSet"
											? "title"
											: record.event._tag === "TurnSettled"
												? "settled"
												: record.event._tag === "MessagePersisted"
													? "activity"
													: null;
									if (reason === null) return;
									const checkpointPublisher = yield* checkpointPublisherFor(
										record.streamId,
									);
									checkpointPublisher.mark(reason === "settled");
									if (reason === "settled") {
										void Effect.runPromise(
											checkpointPublisher.flush.pipe(Effect.ignore),
										);
									}
									if (record.streamId === bootstrap.initialSessionId) {
										yield* summaryPublisher
											.publish(reason)
											.pipe(Effect.retry(cloudRuntimeRetrySchedule));
									}
								}),
							),
							Effect.forkScoped({ startImmediately: true }),
						);

					const launchIntent = bootstrap.launchIntent;
					if (launchIntent !== undefined) {
						const started = yield* startCloudWorkspaceLaunchIntent({
							workspaces,
							chats,
							chatId: bootstrap.chatId,
							sessionId: bootstrap.initialSessionId,
							workspaceRoot: config.workspaceRoot,
							launchIntent,
						}).pipe(Effect.result);
						if (started._tag === "Failure") {
							yield* postCurrentRuntimeReady(
								"launch-failed",
								launchIntent.commandId,
								started.failure.reason,
							).pipe(Effect.retry(cloudRuntimeRetrySchedule));
							return yield* Effect.fail(started.failure);
						}
						yield* postCurrentRuntimeReady(
							"agent-started",
							launchIntent.commandId,
							undefined,
							yield* sessionDomain
								.currentStreamVersion(bootstrap.initialSessionId)
								.pipe(
									Effect.mapError(() =>
										fail("workspace_launch_receipt_unavailable"),
									),
								),
						).pipe(Effect.retry(cloudRuntimeRetrySchedule));
					}
					yield* summaryPublisher
						.publish("initial")
						.pipe(Effect.retry(cloudRuntimeRetrySchedule));
					const runtimeChat = yield* chats
						.getChat(ChatId.make(bootstrap.chatId))
						.pipe(
							Effect.mapError(() => fail("workspace_summary_chat_unavailable")),
						);
					yield* chats.streamChatChanges(runtimeChat.projectId).pipe(
						Stream.filter((change) =>
							change._tag === "snapshot"
								? change.chats.some((chat) => chat.id === runtimeChat.id)
								: change.chat.id === runtimeChat.id,
						),
						Stream.runForEach(() =>
							summaryPublisher
								.publish("title")
								.pipe(Effect.retry(cloudRuntimeRetrySchedule)),
						),
						Effect.forkScoped({ startImmediately: true }),
					);
				}),
			);
