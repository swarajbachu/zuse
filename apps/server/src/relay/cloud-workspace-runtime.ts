import { watch } from "node:fs";
import { access, mkdir, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
	AgentSessionId,
	ChatId,
	CloudRuntimeCredential,
	ComposerInput,
	FolderId,
	MessageId,
	ProviderId,
	RelayPaths,
	WIRE_PROTOCOL_VERSION,
} from "@zuse/contracts";
import type { StoredEvent } from "@zuse/domain/engine/dispatch";
import { SessionDomain } from "@zuse/domain/engine/session-domain";
import { Effect, Layer, Redacted, Schedule, Schema, Stream } from "effect";
import { compactDecrypt, exportJWK, generateKeyPair } from "jose";
import {
	ChatService,
	MessageService,
} from "../conversation/services/conversation-services.ts";
import { LanAuthService } from "../lan-auth/services/lan-auth-service.ts";
import type { CredentialsService } from "../provider/services/credentials-service.ts";
import { WorkspaceService } from "../workspace/services/workspace-service.ts";
import { installCloudCredentials } from "./cloud-enrollment.ts";

const CREDENTIALS_READY_MARKER = "/var/lib/zuse/workspace/credentials-ready";
const CREDENTIALS_READY_EVENT =
	"/var/lib/zuse/workspace/credentials-ready-event";
const REPOSITORY_READY_MARKER = "/var/lib/zuse/workspace/repository-ready";
const WORKSPACE_PATH = "/home/zuse/workspace";

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

/**
 * The gateway notification is an acceleration signal, not the durable command
 * transport. Polling guarantees that commands accepted while the gateway is
 * reconnecting are still observed after the one-time startup fetch.
 */
export const pollCloudWorkspaceCommands = <A, E, R>(
	fetchCommands: Effect.Effect<A, E, R>,
): Effect.Effect<void, E, R> =>
	fetchCommands.pipe(
		Effect.retry(Schedule.spaced("1 second")),
		Effect.repeat(Schedule.spaced("1 second")),
		Effect.asVoid,
	);

/**
 * Runtime enrollment depends on a workspace row written immediately before
 * the sandbox starts. A single transient relay or database read failure must
 * not leave an otherwise healthy sandbox permanently detached.
 */
export const retryCloudWorkspaceBootstrap = <A, E, R>(
	bootstrap: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
	bootstrap.pipe(Effect.retry(Schedule.spaced("1 second")));

const BootstrapResponse = Schema.Struct({
	workspaceId: Schema.String,
	runtimeCredential: Schema.String,
	gatewayUrl: Schema.String,
	gatewayProtocol: Schema.String,
	chatId: Schema.String,
	initialSessionId: Schema.String,
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

const Command = Schema.Struct({
	commandId: Schema.String,
	sequence: Schema.Number,
	kind: Schema.Literals(["start-agent", "send-message", "rename-chat"]),
	payload: Schema.Record(Schema.String, Schema.Unknown),
});

const CommandsResponse = Schema.Struct({ commands: Schema.Array(Command) });

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
	phase: "repository-ready" | "agent-started" | "command-acknowledged",
	commandId?: string,
): Effect.Effect<void, CloudWorkspaceRuntimeError> =>
	requestJson({
		schema: Schema.Unknown,
		url: `${config.relayUrl}${RelayPaths.cloudWorkspaceReady(config.workspaceId)}`,
		token: runtimeCredential,
		method: "POST",
		body: { phase, commandId },
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
		// Check after installing the watcher so creation cannot occur between the
		// existence check and subscription.
		check();
		return Effect.sync(() => {
			settled = true;
			watcher.close();
		});
	},
);

type RuntimeCommand = typeof Command.Type;

const eventPayload = (record: StoredEvent) => ({
	runtimeSequence: record.sequence,
	eventId: record.eventId,
	streamId: record.streamId,
	streamVersion: record.streamVersion,
	type: record.event._tag,
	payloadJson: JSON.stringify(record.event),
});

const removeBootToken = (path: string | undefined) =>
	path === undefined
		? Effect.void
		: Effect.tryPromise({
				try: () => unlink(path),
				catch: () => fail("workspace_boot_token_cleanup_failed"),
			}).pipe(Effect.ignore);

const websocketClosed = (
	url: string,
	protocols: ReadonlyArray<string>,
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
		const socket = new WebSocket(url, [...protocols]);
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
 * Cloud-only runtime link. It never registers an environment or advertises an
 * inbound endpoint: the sandbox authenticates once, opens the workspace
 * gateway, mirrors durable events, and reverse-bridges existing RPC frames.
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
	| MessageService
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
					const sessions = yield* SessionDomain;
					const credentialKeyPair = yield* Effect.tryPromise({
						try: () =>
							generateKeyPair("RSA-OAEP-256", {
								extractable: true,
							}),
						catch: () => fail("workspace_credential_key_failed"),
					});
					const credentialPublicJwk = yield* Effect.tryPromise({
						try: async () =>
							JSON.stringify(await exportJWK(credentialKeyPair.publicKey)),
						catch: () => fail("workspace_credential_key_failed"),
					});
					const bootstrap = yield* retryCloudWorkspaceBootstrap(
						requestJson({
							schema: BootstrapResponse,
							url: `${config.relayUrl}${RelayPaths.cloudWorkspaceBootstrap(config.workspaceId)}`,
							token: Redacted.value(config.bootToken),
							method: "POST",
							body: { credentialPublicJwk },
						}),
					);
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
					yield* removeBootToken(config.bootTokenFile);
					const localCredential = yield* auth
						.mintToken("cloud workspace gateway")
						.pipe(
							Effect.mapError(() => fail("workspace_local_rpc_auth_failed")),
						);

					let commandCursor = 0;
					const processedCommands = new Set<string>();
					const processCommand = (command: RuntimeCommand) =>
						Effect.gen(function* () {
							if (processedCommands.has(command.commandId)) return;
							if (command.kind === "rename-chat") {
								if (typeof command.payload.title !== "string")
									return yield* Effect.fail(fail("workspace_rename_invalid"));
								yield* chats
									.renameChat(
										ChatId.make(bootstrap.chatId),
										command.payload.title,
									)
									.pipe(Effect.mapError(() => fail("workspace_rename_failed")));
								yield* postReady(
									config,
									bootstrap.runtimeCredential,
									"command-acknowledged",
									command.commandId,
								);
								processedCommands.add(command.commandId);
								commandCursor = Math.max(commandCursor, command.sequence);
								return;
							}
							if (command.kind === "send-message") {
								const input = Schema.decodeUnknownOption(ComposerInput)(
									command.payload.input,
								);
								if (
									input._tag === "None" ||
									typeof command.payload.clientMessageId !== "string"
								)
									return yield* Effect.fail(
										fail("workspace_message_command_invalid"),
									);
								yield* messages
									.sendMessage(
										AgentSessionId.make(bootstrap.initialSessionId),
										input.value.text,
										input.value.attachments,
										input.value.fileRefs,
										input.value.skillRefs,
										input.value.annotations,
										command.payload.asGoal === true,
										MessageId.make(command.payload.clientMessageId),
									)
									.pipe(
										Effect.mapError(() =>
											fail("workspace_message_delivery_failed"),
										),
									);
								yield* postReady(
									config,
									bootstrap.runtimeCredential,
									"command-acknowledged",
									command.commandId,
								);
								processedCommands.add(command.commandId);
								commandCursor = Math.max(commandCursor, command.sequence);
								return;
							}
							const provider = Schema.decodeUnknownOption(ProviderId)(
								command.payload.agent,
							);
							if (
								provider._tag === "None" ||
								typeof command.payload.model !== "string"
							)
								return yield* Effect.fail(
									fail("workspace_agent_config_invalid"),
								);
							const folders = yield* workspaces.list();
							const folder =
								folders.find(
									(candidate) => candidate.path === WORKSPACE_PATH,
								) ??
								(yield* workspaces
									.add(WORKSPACE_PATH)
									.pipe(
										Effect.mapError(() =>
											fail("workspace_registration_failed"),
										),
									));
							yield* chats
								.createChat({
									chatId: ChatId.make(bootstrap.chatId),
									initialSessionId: AgentSessionId.make(
										bootstrap.initialSessionId,
									),
									projectId: FolderId.make(folder.id),
									title:
										typeof command.payload.title === "string"
											? command.payload.title
											: undefined,
									providerId: provider.value,
									model: command.payload.model,
									initialPrompt:
										typeof command.payload.firstMessage === "string"
											? command.payload.firstMessage
											: undefined,
									background: false,
								})
								.pipe(
									Effect.mapError(() => fail("workspace_agent_start_failed")),
								);
							yield* postReady(
								config,
								bootstrap.runtimeCredential,
								"agent-started",
								command.commandId,
							);
							processedCommands.add(command.commandId);
							commandCursor = Math.max(commandCursor, command.sequence);
						});

					const fetchCommands = () =>
						requestJson({
							schema: CommandsResponse,
							url: `${config.relayUrl}${RelayPaths.cloudWorkspaceCommands(config.workspaceId)}?after=${commandCursor}`,
							token: bootstrap.runtimeCredential,
						}).pipe(
							Effect.flatMap((response) =>
								Effect.forEach(response.commands, processCommand, {
									concurrency: 1,
									discard: true,
								}),
							),
						);

					let lastActivityPublishedAt = 0;
					const publishActivity = () => {
						const now = Date.now();
						if (now - lastActivityPublishedAt < 30_000) return;
						lastActivityPublishedAt = now;
						void Effect.runPromise(
							requestJson({
								schema: Schema.Unknown,
								url: `${config.relayUrl}${RelayPaths.cloudWorkspaceActivity(config.workspaceId)}`,
								token: bootstrap.runtimeCredential,
								method: "POST",
							}).pipe(Effect.ignore),
						);
					};
					const replicateEvent = (record: StoredEvent) =>
						requestJson({
							schema: Schema.Unknown,
							url: `${config.relayUrl}${RelayPaths.cloudWorkspaceEvents(config.workspaceId)}`,
							token: bootstrap.runtimeCredential,
							method: "POST",
							body: { events: [eventPayload(record)] },
						}).pipe(
							Effect.tap(() => Effect.sync(publishActivity)),
							Effect.asVoid,
						);
					yield* sessions.allEvents({ afterSequence: 0 }).pipe(
						Stream.runForEach(replicateEvent),
						// The local event log is the runtime outbox. Keep replaying after
						// transient relay failures; the control plane deduplicates event IDs.
						Effect.retry(Schedule.spaced("1 second")),
						Effect.forkScoped({ startImmediately: true }),
					);

					const localSockets = new Map<string, WebSocket>();
					const pendingFrames = new Map<string, Array<string | ArrayBuffer>>();
					let gateway: WebSocket | null = null;
					const sendGateway = (message: unknown) => {
						if (gateway?.readyState === WebSocket.OPEN)
							gateway.send(JSON.stringify(message));
					};
					const openLocal = (connectionId: string) => {
						if (localSockets.has(connectionId)) return;
						const url = new URL(`ws://127.0.0.1:${config.localPort}`);
						url.searchParams.set("token", localCredential.token);
						url.searchParams.set("wireVersion", String(WIRE_PROTOCOL_VERSION));
						const socket = new WebSocket(url);
						socket.binaryType = "arraybuffer";
						localSockets.set(connectionId, socket);
						socket.addEventListener("open", () => {
							for (const frame of pendingFrames.get(connectionId) ?? [])
								socket.send(frame);
							pendingFrames.delete(connectionId);
						});
						socket.addEventListener("message", (event) => {
							publishActivity();
							if (typeof event.data === "string")
								sendGateway({
									type: "runtime.frame",
									connectionId,
									encoding: "text",
									payload: event.data,
								});
							else if (event.data instanceof ArrayBuffer)
								sendGateway({
									type: "runtime.frame",
									connectionId,
									encoding: "base64",
									payload: Buffer.from(event.data).toString("base64"),
								});
						});
						socket.addEventListener("close", () =>
							localSockets.delete(connectionId),
						);
					};

					const connectGateway = websocketClosed(
						bootstrap.gatewayUrl,
						[bootstrap.gatewayProtocol, bootstrap.runtimeCredential],
						(socket) => {
							gateway = socket;
							socket.addEventListener("message", (event) => {
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
								}
								if (
									message.type === "client.frame" &&
									typeof message.connectionId === "string" &&
									typeof message.payload === "string"
								) {
									publishActivity();
									const frame =
										message.encoding === "base64"
											? Uint8Array.from(Buffer.from(message.payload, "base64"))
													.buffer
											: message.payload;
									const local = localSockets.get(message.connectionId);
									if (local?.readyState === WebSocket.OPEN) local.send(frame);
									else {
										const queued =
											pendingFrames.get(message.connectionId) ?? [];
										queued.push(frame);
										pendingFrames.set(message.connectionId, queued);
										openLocal(message.connectionId);
									}
								}
								// Durable command polling below is authoritative. Gateway
								// notifications remain a latency hint for a future serialized pump.
							});
						},
					).pipe(
						Effect.retry(Schedule.exponential("100 millis")),
						Effect.ensuring(
							Effect.sync(() => {
								gateway = null;
								for (const socket of localSockets.values()) socket.close();
								localSockets.clear();
							}),
						),
					);
					yield* connectGateway.pipe(
						Effect.forkScoped({ startImmediately: true }),
					);
					yield* waitForRepository;
					yield* postReady(
						config,
						bootstrap.runtimeCredential,
						"repository-ready",
					);
					yield* pollCloudWorkspaceCommands(fetchCommands()).pipe(
						Effect.forkScoped({ startImmediately: true }),
					);
				}),
			);
