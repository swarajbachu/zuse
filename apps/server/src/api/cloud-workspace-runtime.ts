import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { watch } from "node:fs";
import { access, mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
	AgentSessionId,
	AgentTurnId,
	ApiPaths,
	ChatId,
	CLOUD_TRANSCRIPT_CHECKPOINT_SCHEMA_VERSION,
	CloudTranscriptCheckpointPayload,
	CloudTranscriptMessagePagePayload,
	CloudWorkspaceRuntimeSummary,
	decodeWorkspaceGatewayFrame,
	encodeWorkspaceGatewayFrame,
	FolderId,
	MessageId,
	ProviderId,
	SessionId,
	WIRE_PROTOCOL_VERSION,
	WORKSPACE_GATEWAY_AUTH_EXPIRED_CLOSE,
	WORKSPACE_GATEWAY_STALE_GENERATION_CLOSE,
	WORKSPACE_GATEWAY_UPDATE_REQUIRED_CLOSE,
	workspaceGatewayArrayBuffer,
} from "@zuse/contracts";
import { SessionDomain } from "@zuse/domain/engine/session-domain";
import {
	cloudTranscriptAdditionalData,
	encryptCloudTranscript,
	sha256Base64Url,
} from "@zuse/utils/cloud-transcript-crypto";
import {
	Clock,
	Deferred,
	Duration,
	Effect,
	Layer,
	Redacted,
	Schedule,
	Schema,
	Semaphore,
	Stream,
} from "effect";
import {
	type CryptoKey,
	compactDecrypt,
	exportJWK,
	generateKeyPair,
	SignJWT,
} from "jose";
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

const CREDENTIALS_READY_MARKER = "/var/lib/zuse/workspace/credentials-ready";
const CREDENTIALS_READY_EVENT =
	"/var/lib/zuse/workspace/credentials-ready-event";
const REPOSITORY_READY_MARKER = "/var/lib/zuse/workspace/repository-ready";
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
	{ reason: Schema.String },
) {}

const fail = (reason: string) => new CloudWorkspaceRuntimeError({ reason });

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
}): Effect.Effect<A, CloudWorkspaceRuntimeError> =>
	Effect.tryPromise({
		try: async () => {
			const response = await fetch(input.url, {
				method: input.method ?? "GET",
				headers: {
					authorization: `Bearer ${input.token}`,
					...(input.body === undefined
						? {}
						: { "content-type": "application/json" }),
				},
				body: input.body === undefined ? undefined : JSON.stringify(input.body),
			});
			if (!response.ok) throw new Error(`api_${response.status}`);
			return response.json() as Promise<unknown>;
		},
		catch: (cause) =>
			fail(cause instanceof Error ? cause.message : "api_request_failed"),
	}).pipe(
		Effect.flatMap(Schema.decodeUnknownEffect(input.schema)),
		Effect.mapError((error) =>
			error instanceof CloudWorkspaceRuntimeError
				? error
				: fail("api_invalid_response"),
		),
	);

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
		body: { phase, launchCommandId, errorCode, sessionHeadVersion },
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
> =>
	config === undefined
		? Layer.empty
		: Layer.effectDiscard(
				Effect.gen(function* () {
					const auth = yield* LanAuthService;
					const workspaces = yield* WorkspaceService;
					const chats = yield* ChatService;
					const messages = yield* MessageService;
					const credentials = yield* CredentialsService;
					yield* installImageProviderSecrets(credentials);
					const sessionDomain = yield* SessionDomain;
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
					const gatewayOpened = yield* Deferred.make<void>();
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
							void Effect.runPromise(
								Deferred.succeed(gatewayOpened, undefined),
							);
							const reconnectPhase =
								runtimeReadyPhaseOnGatewayOpen(repositoryReady);
							if (reconnectPhase !== null)
								void Effect.runPromise(
									postReady(
										config,
										runtimeCredential.credential,
										reconnectPhase,
									).pipe(Effect.ignore),
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

					yield* Effect.all(
						[waitForRepository, Deferred.await(gatewayOpened)],
						{ concurrency: "unbounded" },
					);
					yield* postReady(
						config,
						runtimeCredential.credential,
						"repository-ready",
					).pipe(Effect.retry(cloudRuntimeRetrySchedule));
					repositoryReady = true;
					yield* acknowledgeBootstrap.pipe(
						Effect.forkScoped({ startImmediately: true }),
					);

					// Transcript and summary maintenance are not prerequisites for a usable
					// sandbox. Start them after the gateway and worktree are ready so they
					// never extend workspace setup latency.
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
							yield* postReady(
								config,
								runtimeCredential.credential,
								"launch-failed",
								launchIntent.commandId,
								started.failure.reason,
							).pipe(Effect.retry(cloudRuntimeRetrySchedule));
							return yield* Effect.fail(started.failure);
						}
						yield* postReady(
							config,
							runtimeCredential.credential,
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
