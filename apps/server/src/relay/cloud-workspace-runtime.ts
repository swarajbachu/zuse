import { randomUUID } from "node:crypto";
import { watch } from "node:fs";
import { access, mkdir, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
	AgentSessionId,
	AgentTurnId,
	ChatId,
	CloudRuntimeCredential,
	CloudWorkspaceRuntimeSummary,
	decodeWorkspaceGatewayFrame,
	encodeWorkspaceGatewayFrame,
	FolderId,
	MessageId,
	ProviderId,
	RelayPaths,
	WIRE_PROTOCOL_VERSION,
	workspaceGatewayArrayBuffer,
} from "@zuse/contracts";
import { SessionDomain } from "@zuse/domain/engine/session-domain";
import {
	Clock,
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
} from "../conversation/services/conversation-services.ts";
import { LanAuthService } from "../lan-auth/services/lan-auth-service.ts";
import type { CredentialsService } from "../provider/services/credentials-service.ts";
import {
	WorkspaceService,
	type WorkspaceServiceShape,
} from "../workspace/services/workspace-service.ts";
import { installCloudCredentials } from "./cloud-enrollment.ts";

const CREDENTIALS_READY_MARKER = "/var/lib/zuse/workspace/credentials-ready";
const CREDENTIALS_READY_EVENT =
	"/var/lib/zuse/workspace/credentials-ready-event";
const REPOSITORY_READY_MARKER = "/var/lib/zuse/workspace/repository-ready";
export const CLOUD_WORKSPACE_ROOT = "/home/zuse/workspace";

export interface CloudWorkspaceRuntimeConfig {
	readonly workspaceId: string;
	readonly relayUrl: string;
	readonly bootToken: Redacted.Redacted<string>;
	readonly bootTokenFile?: string;
	readonly localPort: number;
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
 * the sandbox starts. A transient relay/database error must not strand a
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
	cloudCredentials: Schema.Array(
		Schema.Struct({
			kind: Schema.Literals(["github", "claude", "codex"]),
			credentialType: Schema.Literals([
				"api-key",
				"oauth-token",
				"repository-token",
				"native-store",
			]),
			sealedSecret: Schema.String,
			version: Schema.Number,
		}),
	),
});

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

interface RuntimeCredentialState {
	credential: string;
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

/**
 * Serializes summary writes and retries a failed revision instead of skipping
 * it. Activity checkpoints are bounded to one write every 30 seconds; title
 * and settlement changes bypass the throttle so the catalog converges at turn
 * boundaries without carrying transcript content through Relay.
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
				// A preserved process can reconnect after Relay already accepted a
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
	readonly relayIssuer: string;
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
				.setAudience(input.relayIssuer)
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
				relayIssuer: input.config.relayUrl,
				workspaceId: input.config.workspaceId,
				requestId: input.requestId,
				generation: current.generation,
				gatewayEpoch: current.gatewayEpoch,
				nowMs,
			});
			const result = yield* requestJson({
				schema: RuntimeCredentialRenewalResponse,
				url: `${input.config.relayUrl}${RelayPaths.cloudWorkspaceRuntimeCredentialsRenew(
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
			if (!response.ok) throw new Error(`relay_${response.status}`);
			return response.json() as Promise<unknown>;
		},
		catch: (cause) =>
			fail(cause instanceof Error ? cause.message : "relay_request_failed"),
	}).pipe(
		Effect.flatMap(Schema.decodeUnknownEffect(input.schema)),
		Effect.mapError((error) =>
			error instanceof CloudWorkspaceRuntimeError
				? error
				: fail("relay_invalid_response"),
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
		url: `${config.relayUrl}${RelayPaths.cloudWorkspaceReady(config.workspaceId)}`,
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
			folders.find((candidate) => candidate.path === CLOUD_WORKSPACE_ROOT) ??
			(yield* input.workspaces
				.add(CLOUD_WORKSPACE_ROOT)
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
			() => finish(Effect.fail(fail("workspace_gateway_unreachable"))),
			{ once: true },
		);
		socket.addEventListener(
			"close",
			() => finish(Effect.fail(fail("workspace_gateway_disconnected"))),
			{ once: true },
		);
		return Effect.sync(() => socket.close());
	});

/**
 * Cloud-only runtime link. The workspace runtime owns all chat state and keeps
 * consuming providers independently of client sockets. Relay is used only for
 * bootstrap/auth/lifecycle and as an opaque hibernatable WebSocket router.
 */
export const makeCloudWorkspaceRuntimeLayer = (
	config: CloudWorkspaceRuntimeConfig | undefined,
): Layer.Layer<
	never,
	CloudWorkspaceRuntimeError,
	| CredentialsService
	| LanAuthService
	| WorkspaceService
	| ChatService
	| SessionDomain
> =>
	config === undefined
		? Layer.empty
		: Layer.effectDiscard(
				Effect.gen(function* () {
					const auth = yield* LanAuthService;
					const workspaces = yield* WorkspaceService;
					const chats = yield* ChatService;
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
							url: `${config.relayUrl}${RelayPaths.cloudWorkspaceBootstrap(config.workspaceId)}`,
							token: Redacted.value(config.bootToken),
							method: "POST",
							body: { credentialPublicJwk, signingPublicJwk },
						}),
					);
					const runtimeCredential: RuntimeCredentialState = {
						credential: bootstrap.runtimeCredential,
						expiresAt: bootstrap.runtimeCredentialExpiresAt,
						generation: bootstrap.runtimeGeneration,
						gatewayEpoch: bootstrap.gatewayEpoch,
					};
					yield* superviseRuntimeCredential({
						config,
						signingPrivateKey: signingKeyPair.privateKey,
						state: runtimeCredential,
					}).pipe(Effect.forkScoped({ startImmediately: true }));
					const cloudCredentials = yield* Effect.forEach(
						bootstrap.cloudCredentials,
						(credential) =>
							Effect.tryPromise({
								try: async () => {
									const decrypted = await compactDecrypt(
										credential.sealedSecret,
										credentialKeyPair.privateKey,
									);
									return new CloudRuntimeCredential({
										kind: credential.kind,
										credentialType: credential.credentialType,
										secret: new TextDecoder().decode(decrypted.plaintext),
										version: credential.version,
									});
								},
								catch: () => fail("workspace_credential_decryption_failed"),
							}),
					);
					yield* installCloudCredentials(cloudCredentials).pipe(
						Effect.mapError(() => fail("workspace_credential_install_failed")),
					);
					yield* writeCredentialsReady;
					yield* retryCloudWorkspaceBootstrap(
						requestJson({
							schema: RuntimeBootstrapAckResponse,
							url: `${config.relayUrl}${RelayPaths.cloudWorkspaceBootstrapAck(config.workspaceId)}`,
							token: runtimeCredential.credential,
							method: "POST",
							body: {
								runtimeGeneration: runtimeCredential.generation,
								gatewayEpoch: runtimeCredential.gatewayEpoch,
							},
						}),
					);
					yield* removeBootToken(config.bootTokenFile);
					const localCredential = yield* auth
						.mintToken("cloud workspace gateway")
						.pipe(
							Effect.mapError(() => fail("workspace_local_rpc_auth_failed")),
						);

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
								url: `${config.relayUrl}${RelayPaths.cloudWorkspaceSummary(config.workspaceId)}`,
								token: runtimeCredential.credential,
								method: "POST",
								body: summary,
							}).pipe(
								Effect.mapError(() => fail("workspace_summary_publish_failed")),
							),
					});
					const publishActivity = () => {
						void Effect.runPromise(
							summaryPublisher.publish("activity").pipe(Effect.ignore),
						);
					};
					const sessionEventCursor = yield* sessionDomain.currentSequence.pipe(
						Effect.mapError(() => fail("workspace_summary_cursor_unavailable")),
					);
					yield* sessionDomain
						.allEvents({ afterSequence: sessionEventCursor })
						.pipe(
							Stream.filter(
								(record) => record.streamId === bootstrap.initialSessionId,
							),
							Stream.runForEach((record) => {
								const reason: RuntimeSummaryReason | null =
									record.event._tag === "SessionTitleSet"
										? "title"
										: record.event._tag === "TurnSettled"
											? "settled"
											: record.event._tag === "MessagePersisted"
												? "activity"
												: null;
								return reason === null
									? Effect.void
									: summaryPublisher
											.publish(reason)
											.pipe(Effect.retry(cloudRuntimeRetrySchedule));
							}),
							Effect.forkScoped({ startImmediately: true }),
						);

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

					const connectGateway = websocketClosed(
						bootstrap.gatewayUrl,
						() => [bootstrap.gatewayProtocol, runtimeCredential.credential],
						(socket) => {
							gateway = socket;
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
						Effect.retry(cloudRuntimeRetrySchedule),
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

					yield* waitForRepository;
					const launchIntent = bootstrap.launchIntent;
					if (launchIntent !== undefined) {
						const started = yield* startCloudWorkspaceLaunchIntent({
							workspaces,
							chats,
							chatId: bootstrap.chatId,
							sessionId: bootstrap.initialSessionId,
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
					} else {
						// A resumed workspace already has its durable chat/session. A newly
						// launched workspace does not become attachable until the launch
						// intent above has created them and Relay has atomically recorded its
						// receipt. Advertising repository-ready before that point lets the
						// client timeline race the session transaction and reconnect-loop on
						// SessionNotFoundError.
						yield* postReady(
							config,
							runtimeCredential.credential,
							"repository-ready",
						).pipe(Effect.retry(cloudRuntimeRetrySchedule));
					}
					repositoryReady = true;
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
