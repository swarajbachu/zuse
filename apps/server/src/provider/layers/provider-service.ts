import { execFileSync } from "node:child_process";
import { startClaudeSession } from "@zuse/agents/drivers/claude";
import { startCodexSession } from "@zuse/agents/drivers/codex";
import { startCursorSession } from "@zuse/agents/drivers/cursor";
import { startGeminiSession } from "@zuse/agents/drivers/gemini";
import { startGrokSession } from "@zuse/agents/drivers/grok";
import { startKiroSession } from "@zuse/agents/drivers/kiro";
import { startOpencodeSession } from "@zuse/agents/drivers/opencode";
import { startOpencode2Session } from "@zuse/agents/drivers/opencode2";
import { startPiSession } from "@zuse/agents/drivers/pi";
import { AttachmentService } from "@zuse/agents/kernel/attachment-service";
import type {
	GoalCapableSessionHandle,
	ProviderSessionHandle,
} from "@zuse/agents/kernel/driver";
import {
	makeTurnScopedSessionHandle,
	type TurnScopedProviderEventEnvelope,
	type TurnScopedProviderSessionHandle,
} from "@zuse/agents/kernel/turn-protocol";
import { zuseWorkspaceInstructions } from "@zuse/agents/kernel/workspace-instructions";
import {
	classifyTool,
	inputLengthBucket,
	safeModelId,
	TurnAnalyticsAccumulator,
} from "@zuse/analytics";
import {
	AgentAvailability,
	AgentEvent,
	type AgentItemId,
	type AgentSessionId,
	AgentSessionNotFoundError,
	AgentSessionStartError,
	CredentialValidationError,
	DEFAULT_RUNTIME_MODE,
	type FolderId,
	type PermissionDecision,
	type PermissionKind,
	type ProviderEventEnvelope,
	ProviderId,
	SessionModeUnsupportedError,
	SessionOperationUnsupportedError,
	ThreadGoal,
	type ThreadGoalSetInput,
	type UserQuestion,
} from "@zuse/contracts";
import { KeyedEffectSerialWorker } from "@zuse/utils/keyed-worker";
import {
	Cache,
	Effect,
	FileSystem,
	Layer,
	Schema,
	Semaphore,
	Stream,
} from "effect";
import { ChildProcessSpawner as CommandExecutor } from "effect/unstable/process";
import { AnalyticsService } from "../../analytics/services/analytics-service.ts";
import { ConfigStoreService } from "../../config-store/services/config-store-service.ts";
import { ExtensionService } from "../../extension/services/extension-service.ts";
import {
	legacyAppOwnedCodexServerNames,
	readNativeServers,
} from "../../mcp/native-config.ts";
import { McpService } from "../../mcp/services/mcp-service.ts";
import {
	ModelCatalogService,
	toDriverModelDescriptor,
} from "../../model-catalog/services/model-catalog-service.ts";
import { WorkspaceService } from "../../workspace/services/workspace-service.ts";
import { validateApiKey } from "../api-key-validation.ts";
import { probeProvidersWithPaths, resolveCliPath } from "../availability.ts";
import { makeProviderSessionRegistry } from "../provider-session-registry.ts";
import { makeQuestionAttachmentAuthority } from "../question-attachment-authority.ts";
import { makeQuestionAttachmentSnapshotFeed } from "../question-attachment-feed.ts";
import { BrowserBridgeService } from "../services/browser-bridge-service.ts";
import { CredentialsService } from "../services/credentials-service.ts";
import { PermissionService } from "../services/permission-service.ts";
import { ProviderService } from "../services/provider-service.ts";
import { RuntimeProviderCredentials } from "../services/runtime-provider-credentials.ts";

/**
 * Live provider runtime. Handles own their scopes and are published through a
 * generation-checked registry, so an older asynchronous startup cannot replace
 * the provider selected by a newer session command.
 */
type SessionHandle = TurnScopedProviderSessionHandle;

const isPublicProviderEvent = (
	envelope: TurnScopedProviderEventEnvelope,
): envelope is ProviderEventEnvelope =>
	envelope.event._tag !== "QuestionCallbackReleased";

/**
 * Handles that expose goal mode. Codex backs it with `thread/goal/*` RPCs;
 * Grok forwards to its native `/goal` slash command with driver-local state.
 * Both share the same method shape so the goal routes treat them uniformly.
 */
type GoalCapableHandle = GoalCapableSessionHandle;
type SessionEntry = {
	readonly providerId: ProviderId;
	readonly model: string;
	readonly handle: SessionHandle;
	turnStartedAt: number | null;
	turnAnalytics: TurnAnalyticsAccumulator;
};

let sessionCounter = 0;
const nextSessionId = (): AgentSessionId =>
	`s_${Date.now()}_${++sessionCounter}` as AgentSessionId;

export const ProviderServiceLive = Layer.effect(
	ProviderService,
	Effect.gen(function* () {
		const executor = yield* CommandExecutor.ChildProcessSpawner;
		const fs = yield* FileSystem.FileSystem;
		const credentials = yield* CredentialsService;
		const runtimeCredentials = yield* RuntimeProviderCredentials;
		const modelCatalog = yield* ModelCatalogService;
		const workspace = yield* WorkspaceService;
		const permissions = yield* PermissionService;
		const attachmentService = yield* AttachmentService;
		const browserBridge = yield* BrowserBridgeService;
		const configStore = yield* ConfigStoreService;
		const mcp = yield* McpService;
		const analytics = yield* AnalyticsService;
		const extensions = yield* ExtensionService;
		const runtime = yield* Effect.context<never>();
		const registry = makeProviderSessionRegistry<
			AgentSessionId,
			SessionEntry
		>();
		// Identical startup requests serialize and reuse the published handle;
		// different provider/model generations may start concurrently so a slow,
		// stale process can never head-of-line block the user's latest selection.
		const startupWorker = new KeyedEffectSerialWorker<string>();
		const lifecycleWorker = new KeyedEffectSerialWorker<AgentSessionId>();
		const startupPermits = yield* Semaphore.make(4);
		const questionAttachments =
			makeQuestionAttachmentAuthority<AgentSessionNotFoundError>();
		const questionAttachmentChanges = yield* makeQuestionAttachmentSnapshotFeed;
		const publishQuestionSnapshot = (): Effect.Effect<void> =>
			questionAttachmentChanges.publish(questionAttachments.snapshot());
		const attachQuestion = (
			sessionId: AgentSessionId,
			itemId: AgentItemId,
			questions: ReadonlyArray<UserQuestion>,
			handle: SessionHandle,
		): Effect.Effect<"attached" | "duplicate" | "conflict" | "full"> =>
			Effect.gen(function* () {
				const attachment = { sessionId, itemId };
				const admission = questionAttachments.attach(attachment, questions);
				if (admission === "conflict") {
					// A replay with different metadata must not replace or cancel the
					// original callback authority. Suppress only the conflicting envelope;
					// the first, exact question remains visible and answerable.
					yield* Effect.logWarning(
						`[ProviderService] suppressed conflicting question metadata for ${sessionId}/${itemId}`,
					);
					return admission;
				}
				if (admission === "duplicate") return admission;
				if (admission === "full") {
					// Never forward a durable question that has no corresponding live
					// authority. Cancel the exact callback; if a broken driver cannot do
					// that, close it so its bounded waiter registry is still drained.
					yield* (handle.cancelQuestion?.(itemId) ?? handle.close()).pipe(
						Effect.catch(() =>
							handle.close().pipe(Effect.catch(() => Effect.void)),
						),
					);
					return admission;
				}
				yield* publishQuestionSnapshot();
				return admission;
			});
		const detachQuestion = (
			sessionId: AgentSessionId,
			itemId: AgentItemId,
		): Effect.Effect<boolean> =>
			Effect.gen(function* () {
				const removed = questionAttachments.detach(sessionId, itemId);
				if (!removed) return false;
				yield* publishQuestionSnapshot();
				return true;
			});
		const detachSessionQuestions = (
			sessionId: AgentSessionId,
		): Effect.Effect<void> =>
			Effect.gen(function* () {
				const detached = questionAttachments.detachSession(sessionId);
				if (detached.length === 0) return;
				yield* publishQuestionSnapshot();
			});

		// The Claude SDK's `canUseTool` callback returns a Promise; here we
		// shim PermissionService.request into that signature using the live
		// runtime captured at layer construction. `projectId` is bound at
		// start() time so the driver doesn't need to know about projects.
		const buildRequestPermission =
			(projectId: FolderId) =>
			(
				sessionId: AgentSessionId,
				kind: PermissionKind,
				options: { readonly forcePrompt: boolean },
			): Promise<PermissionDecision> =>
				Effect.runPromiseWith(runtime)(
					permissions.request(sessionId, kind, {
						projectId,
						forcePrompt: options.forcePrompt,
					}),
				);

		const availabilityCache = yield* Cache.make({
			capacity: 1,
			lookup: () =>
				Effect.gen(function* () {
					const paths =
						(yield* configStore.getSettings()).providerBinaryPaths ?? {};
					const list = yield* probeProvidersWithPaths(paths).pipe(
						Effect.provideService(
							CommandExecutor.ChildProcessSpawner,
							executor,
						),
						Effect.provideService(FileSystem.FileSystem, fs),
					);
					// Keychain enumeration is best-effort for CLI-backed providers. The
					// bundled provider is overlaid from its app-managed credential and
					// never trusts a local login or inherited environment value.
					const configured = yield* credentials
						.listConfigured()
						.pipe(
							Effect.catch(() =>
								Effect.succeed([] as ReadonlyArray<ProviderId>),
							),
						);
					const configuredSet = new Set<ProviderId>(configured);
					const managedApiKey = configuredSet.has("cursor")
						? yield* credentials
								.get("cursor")
								.pipe(Effect.catch(() => Effect.succeed<string | null>(null)))
						: null;
					const legacyProviders = list
						.filter((item) => item.providerId !== "cursor")
						.map(
							(a): AgentAvailability => ({
								...a,
								runtimeKind: "cli",
								runtimeAvailable: a.cliInstalled,
								hasApiKey: configuredSet.has(a.providerId),
							}),
						);
					const cursorBase = {
						providerId: "cursor" as const,
						displayName: "Cursor",
						runtimeKind: "bundledSdk" as const,
						runtimeAvailable: true,
						cliInstalled: false,
						cliLoggedIn: false,
						hasApiKey: managedApiKey !== null,
						lastCheckedAt: new Date(),
					};
					if (managedApiKey === null || managedApiKey.trim().length === 0) {
						return [
							...legacyProviders,
							AgentAvailability.make({
								...cursorBase,
								hasApiKey: false,
								authStatus: "unauthenticated",
								status: "warning",
								statusMessage:
									"API key required. Add one in provider settings.",
							}),
						];
					}
					const validation = yield* validateApiKey(managedApiKey);
					const cursorAvailability =
						validation.status === "verified"
							? AgentAvailability.make({
									...cursorBase,
									apiKeyStatus: "verified",
									authStatus: "authenticated",
									authType: "apiKey",
									status: "ready",
								})
							: validation.status === "invalid"
								? AgentAvailability.make({
										...cursorBase,
										apiKeyStatus: "invalid",
										authStatus: "unauthenticated",
										authType: "apiKey",
										status: "error",
										statusMessage: validation.reason,
									})
								: AgentAvailability.make({
										...cursorBase,
										apiKeyStatus: "unverified",
										authStatus: "unknown",
										authType: "apiKey",
										status: "warning",
										statusMessage: validation.warning,
									});
					const extensionProviders = yield* extensions.providers();
					const extensionAvailability = yield* Effect.forEach(
						extensionProviders,
						(descriptor) =>
							Effect.promise(async () => {
								const providerId = Schema.decodeUnknownSync(ProviderId)(
									descriptor.id,
								);
								try {
									const probe = (await Effect.runPromise(
										extensions.invokeProvider(descriptor.id, "probe", {}),
									)) as {
										readonly available?: boolean;
										readonly authenticated?: boolean;
										readonly version?: string;
										readonly message?: string;
									};
									return AgentAvailability.make({
										providerId,
										displayName: descriptor.displayName,
										runtimeKind: "extension",
										runtimeAvailable: probe.available === true,
										cliInstalled: false,
										cliVersion: probe.version,
										cliLoggedIn: probe.authenticated === true,
										hasApiKey: probe.authenticated === true,
										authStatus:
											probe.authenticated === true
												? "authenticated"
												: "unauthenticated",
										status:
											probe.available === true && probe.authenticated === true
												? "ready"
												: "warning",
										statusMessage: probe.message,
										lastCheckedAt: new Date(),
									});
								} catch (cause) {
									return AgentAvailability.make({
										providerId,
										displayName: descriptor.displayName,
										runtimeKind: "extension",
										runtimeAvailable: false,
										cliInstalled: false,
										cliLoggedIn: false,
										hasApiKey: false,
										authStatus: "unknown",
										status: "error",
										statusMessage:
											cause instanceof Error ? cause.message : String(cause),
										lastCheckedAt: new Date(),
									});
								}
							}),
						{ concurrency: 4 },
					);
					return [
						...legacyProviders,
						cursorAvailability,
						...extensionAvailability,
					];
				}),
		});

		const availability = (refresh = false) =>
			Effect.gen(function* () {
				const key = JSON.stringify(
					(yield* configStore.getSettings()).providerBinaryPaths ?? {},
				);
				if (refresh) yield* Cache.invalidate(availabilityCache, key);
				return yield* Cache.get(availabilityCache, key);
			});

		const lookup = (
			sessionId: AgentSessionId,
		): Effect.Effect<SessionEntry, AgentSessionNotFoundError> =>
			Effect.suspend(() => {
				const entry = registry.lookup(sessionId);
				return entry === undefined
					? Effect.fail(new AgentSessionNotFoundError({ sessionId }))
					: Effect.succeed(entry);
			});

		const invalidate = (sessionId: AgentSessionId) =>
			Effect.sync(() => registry.invalidate(sessionId));

		return {
			availability,
			hasSession: (sessionId) =>
				Effect.sync(() => registry.lookup(sessionId) !== undefined),
			guardCurrent: (sessionId, generation, effect) =>
				lifecycleWorker.run(
					sessionId,
					Effect.suspend(() =>
						registry.isCurrent(sessionId, generation)
							? effect.pipe(Effect.as(true))
							: Effect.succeed(false),
					),
				),
			start: (
				input,
				resumeCursor = null,
				getRuntimeMode,
				orchestrationTools = null,
				providerEventCursor = null,
			) => {
				const startupStartedAt = Date.now();
				const sessionId = input.sessionId ?? nextSessionId();
				const requestedModel = input.model
					? safeModelId(input.providerId, input.model)
					: "custom";
				const startupKey = `${sessionId}\u0000${input.providerId}\u0000${requestedModel}`;
				const start = Effect.gen(function* () {
					const binaryPaths =
						(yield* configStore.getSettings()).providerBinaryPaths ?? {};
					// Reserve ownership before awaiting process teardown. If `begin` moved
					// below `handle.close()`, an older startup could outrank a later switch.
					const reservation = yield* lifecycleWorker.run(
						sessionId,
						Effect.sync(() => {
							const existing = registry.lookup(sessionId);
							if (
								existing?.providerId === input.providerId &&
								existing.model === requestedModel
							) {
								return {
									_tag: "reuse" as const,
									generation: registry.currentGeneration(sessionId),
								};
							}
							const removed = registry.invalidate(sessionId);
							return {
								_tag: "start" as const,
								generation: registry.begin(sessionId),
								removed,
							};
						}),
					);
					if (reservation._tag === "reuse") {
						return {
							sessionId,
							generation: reservation.generation,
						};
					}
					if (reservation.removed !== undefined) {
						// Closing may be slow, so keep it outside the ownership lock. The
						// removed handle is detached and cannot affect the reserved generation.
						yield* reservation.removed.handle
							.close()
							.pipe(Effect.catch(() => Effect.void));
					}
					const generation = reservation.generation;
					const runtimeModeGetter =
						getRuntimeMode ?? (() => DEFAULT_RUNTIME_MODE);
					const folder = yield* workspace.findById(input.folderId);
					if (folder === null) {
						return yield* Effect.fail(
							new AgentSessionStartError({
								providerId: input.providerId,
								reason: `Folder ${input.folderId} not found.`,
							}),
						);
					}
					const cwd = input.cwdOverride ?? folder.path;
					// Canonicalize retired / shorthand slugs and attach the resolved
					// descriptor (curated seed merged with the live inventory) so
					// drivers never read a static model list.
					const canonicalModel =
						input.model === undefined
							? undefined
							: yield* modelCatalog.resolveSlug(input.providerId, input.model);
					const modelDescriptor =
						canonicalModel === undefined
							? undefined
							: toDriverModelDescriptor(
									yield* modelCatalog.findModel(
										input.providerId,
										canonicalModel,
									),
								);
					const driverInput = {
						...input,
						...(canonicalModel !== undefined ? { model: canonicalModel } : {}),
						...(modelDescriptor !== undefined ? { modelDescriptor } : {}),
						workspaceInstructions: zuseWorkspaceInstructions({
							projectPath: folder.path,
							includeAppTools: input.providerId !== "pi",
							cwd,
						}),
					};
					const brokeredCredential = yield* Effect.tryPromise({
						try: () => runtimeCredentials.resolve(input.providerId),
						catch: (cause) =>
							new AgentSessionStartError({
								providerId: input.providerId,
								reason:
									typeof cause === "object" &&
									cause !== null &&
									"reason" in cause &&
									typeof cause.reason === "string"
										? cause.reason
										: cause instanceof Error
											? cause.message
											: `${input.providerId}-auth-reconnecting`,
							}),
					});
					const managedCredential =
						brokeredCredential ??
						(yield* credentials
							.getProviderCredential(input.providerId)
							.pipe(Effect.catch(() => Effect.succeed(null))));
					const apiKey =
						managedCredential?.kind === "api-key"
							? managedCredential.secret
							: null;
					let providerHandle: ProviderSessionHandle;
					const extensionDescriptor = (yield* extensions.providers()).find(
						(provider) => provider.id === input.providerId,
					);
					if (extensionDescriptor !== undefined) {
						if (
							resumeCursor !== null &&
							!extensionDescriptor.capabilities.includes("resume")
						) {
							return yield* Effect.fail(
								new AgentSessionStartError({
									providerId: input.providerId,
									reason: "This extension provider does not support resume.",
								}),
							);
						}
						if (
							input.forkFromResume === true &&
							!extensionDescriptor.capabilities.includes("fork")
						) {
							return yield* Effect.fail(
								new AgentSessionStartError({
									providerId: input.providerId,
									reason: "This extension provider does not support fork.",
								}),
							);
						}
						yield* extensions
							.invokeProvider(extensionDescriptor.id, "start", {
								input: {
									sessionId,
									projectId: input.folderId,
									cwd,
									model: input.model ?? null,
									resumeCursor,
									forkFromResume: input.forkFromResume ?? false,
									permissionMode: input.permissionMode ?? "default",
									modelOptions: input.modelOptions ?? {},
								},
							})
							.pipe(
								Effect.mapError(
									(cause) =>
										new AgentSessionStartError({
											providerId: input.providerId,
											reason: cause.reason,
										}),
								),
							);
						providerHandle = {
							events: extensions.providerEvents(sessionId).pipe(
								Stream.map((event) => {
									try {
										return Schema.decodeUnknownSync(AgentEvent)(event);
									} catch (cause) {
										return {
											_tag: "Error" as const,
											message: `Extension emitted an invalid provider event: ${String(cause)}`,
										};
									}
								}),
							),
							send: (text, attachments, fileRefs, skillRefs) =>
								attachments?.length || fileRefs?.length || skillRefs?.length
									? Effect.die(
											new Error(
												"Extension providers currently accept text prompts. Paste the relevant context into your message instead of attaching files or skills.",
											),
										)
									: extensions
											.invokeProvider(extensionDescriptor.id, "send", {
												sessionId,
												text,
											})
											.pipe(Effect.asVoid, Effect.orDie),
							interrupt: () =>
								extensions
									.invokeProvider(extensionDescriptor.id, "interrupt", {
										sessionId,
									})
									.pipe(Effect.asVoid, Effect.orDie),
							close: () =>
								extensions
									.invokeProvider(extensionDescriptor.id, "close", {
										sessionId,
									})
									.pipe(Effect.asVoid, Effect.orDie),
							setPermissionMode: (mode) =>
								extensions
									.invokeProvider(extensionDescriptor.id, "setPermissionMode", {
										sessionId,
										mode,
									})
									.pipe(
										Effect.asVoid,
										Effect.mapError(
											(cause) =>
												new SessionModeUnsupportedError({
													message: cause.reason,
												}),
										),
									),
							answerQuestion: (itemId, answers) =>
								extensions
									.invokeProvider(extensionDescriptor.id, "answerQuestion", {
										sessionId,
										itemId,
										answers,
									})
									.pipe(
										Effect.asVoid,
										Effect.mapError((cause) => new Error(cause.reason)),
									),
							...(extensionDescriptor.capabilities.includes("planApproval")
								? {
										respondToPlan: (itemId, outcome, feedback) =>
											extensions
												.invokeProvider(
													extensionDescriptor.id,
													"respondToPlan",
													{ sessionId, itemId, outcome, feedback },
												)
												.pipe(Effect.asVoid, Effect.orDie),
									}
								: {}),
							...(extensionDescriptor.capabilities.includes("mcp")
								? {
										updateMcpServers: (servers) =>
											extensions
												.invokeProvider(
													extensionDescriptor.id,
													"updateMcpServers",
													{ sessionId, servers },
												)
												.pipe(Effect.asVoid, Effect.orDie),
									}
								: {}),
							...(extensionDescriptor.capabilities.includes("goals")
								? {
										getGoal: () =>
											extensions
												.invokeProvider(extensionDescriptor.id, "getGoal", {
													sessionId,
												})
												.pipe(
													Effect.map((goal) =>
														goal === null
															? null
															: Schema.decodeUnknownSync(ThreadGoal)(goal),
													),
													Effect.orDie,
												),
										setGoal: (goal: ThreadGoalSetInput) =>
											extensions
												.invokeProvider(extensionDescriptor.id, "setGoal", {
													sessionId,
													goal,
												})
												.pipe(
													Effect.map(Schema.decodeUnknownSync(ThreadGoal)),
													Effect.orDie,
												),
										clearGoal: () =>
											extensions
												.invokeProvider(extensionDescriptor.id, "clearGoal", {
													sessionId,
												})
												.pipe(Effect.asVoid, Effect.orDie),
									}
								: {}),
						};
					} else if (input.providerId === "gemini") {
						// Same story as Grok: hand the driver the user's installed
						// `gemini` binary. Surface a clean install message rather than
						// letting spawn fail with ENOENT inside the driver.
						const geminiPath = yield* resolveCliPath(
							"gemini",
							binaryPaths,
						).pipe(
							Effect.provideService(
								CommandExecutor.ChildProcessSpawner,
								executor,
							),
						);
						if (geminiPath === null) {
							return yield* Effect.fail(
								new AgentSessionStartError({
									providerId: "gemini",
									reason:
										"Gemini CLI not found on PATH. Install via `npm i -g @google/gemini-cli` and try again.",
								}),
							);
						}
						const geminiMcpCommand = yield* resolveCliPath(
							"bun",
							binaryPaths,
						).pipe(
							Effect.provideService(
								CommandExecutor.ChildProcessSpawner,
								executor,
							),
						);
						if (geminiMcpCommand === null) {
							return yield* Effect.fail(
								new AgentSessionStartError({
									providerId: "gemini",
									reason:
										"Bun was not found on PATH. It is required for the Gemini MCP stdio fallback.",
								}),
							);
						}
						providerHandle = yield* startGeminiSession(
							driverInput,
							cwd,
							apiKey,
							geminiPath,
							sessionId,
							buildRequestPermission(input.folderId),
							runtimeModeGetter,
							(command) =>
								Effect.runPromiseWith(runtime)(
									browserBridge.send(sessionId, command),
								),
							geminiMcpCommand,
							orchestrationTools,
							resumeCursor,
						).pipe(Effect.provideService(AttachmentService, attachmentService));
					} else if (input.providerId === "pi") {
						const binary = yield* resolveCliPath("pi", binaryPaths).pipe(
							Effect.provideService(
								CommandExecutor.ChildProcessSpawner,
								executor,
							),
						);
						if (binary === null)
							return yield* new AgentSessionStartError({
								providerId: "pi",
								reason: binaryPaths.pi
									? "Invalid Pi binary path. Choose an absolute executable path in provider settings."
									: "Pi CLI not found. Install @earendil-works/pi-coding-agent or set its absolute binary path.",
							});
						providerHandle = yield* startPiSession(
							driverInput,
							cwd,
							binary,
							sessionId,
							resumeCursor,
						).pipe(Effect.provideService(AttachmentService, attachmentService));
					} else if (input.providerId === "kiro") {
						// Kiro CLI exposes ACP via `kiro-cli acp`. Auth is out-of-band
						// (`kiro-cli login`); we only need the binary on PATH.
						const kiroPath = yield* resolveCliPath(
							"kiro-cli",
							binaryPaths,
						).pipe(
							Effect.provideService(
								CommandExecutor.ChildProcessSpawner,
								executor,
							),
						);
						if (kiroPath === null) {
							return yield* Effect.fail(
								new AgentSessionStartError({
									providerId: "kiro",
									reason:
										"Kiro CLI not found on PATH. Install from https://kiro.dev and ensure `kiro-cli` is available, then try again.",
								}),
							);
						}
						const kiroMcpCommand = yield* resolveCliPath(
							"bun",
							binaryPaths,
						).pipe(
							Effect.provideService(
								CommandExecutor.ChildProcessSpawner,
								executor,
							),
						);
						if (kiroMcpCommand === null) {
							return yield* Effect.fail(
								new AgentSessionStartError({
									providerId: "kiro",
									reason:
										"Bun was not found on PATH. It is required for the Kiro MCP stdio fallback.",
								}),
							);
						}
						providerHandle = yield* startKiroSession(
							driverInput,
							cwd,
							kiroPath,
							sessionId,
							buildRequestPermission(input.folderId),
							runtimeModeGetter,
							(command) =>
								Effect.runPromiseWith(runtime)(
									browserBridge.send(sessionId, command),
								),
							kiroMcpCommand,
							orchestrationTools,
							resumeCursor,
						).pipe(Effect.provideService(AttachmentService, attachmentService));
					} else if (input.providerId === "grok") {
						// Same story as Claude/Codex: hand the driver the user's
						// installed `grok` binary (no bundled CLI in our package).
						// Surface a clean install message rather than letting spawn
						// fail with ENOENT inside the driver.
						const grokPath = yield* resolveCliPath("grok", binaryPaths).pipe(
							Effect.provideService(
								CommandExecutor.ChildProcessSpawner,
								executor,
							),
						);
						if (grokPath === null) {
							return yield* Effect.fail(
								new AgentSessionStartError({
									providerId: "grok",
									reason:
										"Grok CLI not found on PATH. Install Grok from https://x.ai/cli and try again.",
								}),
							);
						}
						const mcpProxyCommand = yield* resolveCliPath(
							"bun",
							binaryPaths,
						).pipe(
							Effect.provideService(
								CommandExecutor.ChildProcessSpawner,
								executor,
							),
						);
						providerHandle = yield* startGrokSession(
							driverInput,
							cwd,
							apiKey,
							grokPath,
							sessionId,
							buildRequestPermission(input.folderId),
							runtimeModeGetter,
							(command) =>
								Effect.runPromiseWith(runtime)(
									browserBridge.send(sessionId, command),
								),
							mcpProxyCommand ?? process.execPath,
							orchestrationTools,
							resumeCursor,
							providerEventCursor,
						).pipe(Effect.provideService(AttachmentService, attachmentService));
					} else if (input.providerId === "opencode") {
						// OpenCode spawns a local HTTP server (`opencode serve`) and we
						// drive it via @opencode-ai/sdk. Same install-message pattern
						// as the other CLI-backed drivers — surface a clean error
						// before the driver tries to spawn.
						const opencodePath = yield* resolveCliPath(
							"opencode",
							binaryPaths,
						).pipe(
							Effect.provideService(
								CommandExecutor.ChildProcessSpawner,
								executor,
							),
						);
						if (opencodePath === null) {
							return yield* Effect.fail(
								new AgentSessionStartError({
									providerId: "opencode",
									reason:
										"OpenCode CLI not found on PATH. Install via `curl -fsSL https://opencode.ai/install | bash` and try again.",
								}),
							);
						}
						// Custom OpenAI-compatible providers are injected into
						// `opencode serve` via OPENCODE_CONFIG_CONTENT; their API keys
						// live in opencode's own auth.json (written via
						// `agent.opencodeSetProviderAuth`), so no key is threaded here.
						const opencodeSettings = yield* configStore.getSettings();
						providerHandle = yield* startOpencodeSession(
							driverInput,
							cwd,
							opencodeSettings.opencodeCustomProviders,
							opencodePath,
							sessionId,
							resumeCursor,
						).pipe(Effect.provideService(AttachmentService, attachmentService));
					} else if (input.providerId === "opencode2") {
						const opencode2Path = yield* resolveCliPath(
							"opencode2",
							binaryPaths,
						).pipe(
							Effect.provideService(
								CommandExecutor.ChildProcessSpawner,
								executor,
							),
						);
						if (opencode2Path === null) {
							return yield* Effect.fail(
								new AgentSessionStartError({
									providerId: "opencode2",
									reason:
										"OpenCode 2 CLI not found on PATH. Install via `curl -fsSL https://opencode.ai/v2/install | bash` and try again.",
								}),
							);
						}
						const opencode2Settings = yield* configStore.getSettings();
						providerHandle = yield* startOpencode2Session(
							driverInput,
							cwd,
							opencode2Settings.opencode2CustomProviders,
							opencode2Path,
							sessionId,
							resumeCursor,
							buildRequestPermission(input.folderId),
						).pipe(Effect.provideService(AttachmentService, attachmentService));
					} else if (input.providerId === "cursor") {
						const userMcpServers = yield* mcp.resolveForCursorSession(cwd);
						providerHandle = yield* startCursorSession(
							driverInput,
							cwd,
							apiKey,
							sessionId,
							resumeCursor,
							userMcpServers,
						).pipe(Effect.provideService(AttachmentService, attachmentService));
					} else if (input.providerId === "claude") {
						// Point the SDK at the user's installed `claude` binary. We
						// don't ship the SDK's bundled optional native CLI (216 MB per
						// arch) — if `which claude` finds nothing here, the SDK would
						// throw a cryptic "Native CLI binary for darwin-arm64 not
						// found" error. Surface a clean install-Claude-Code message
						// instead.
						const claudePath = yield* resolveCliPath(
							"claude",
							binaryPaths,
						).pipe(
							Effect.provideService(
								CommandExecutor.ChildProcessSpawner,
								executor,
							),
						);
						if (claudePath === null) {
							return yield* Effect.fail(
								new AgentSessionStartError({
									providerId: "claude",
									reason:
										"Claude Code CLI not found on PATH. Install Claude Code from https://docs.claude.com/en/docs/claude-code and try again.",
								}),
							);
						}
						const userMcpServers = yield* mcp.resolveForClaudeSession(cwd);

						providerHandle = yield* startClaudeSession(
							driverInput,
							cwd,
							managedCredential,
							claudePath,
							sessionId,
							buildRequestPermission(input.folderId),
							runtimeModeGetter,
							resumeCursor,
							(command) =>
								Effect.runPromiseWith(runtime)(
									browserBridge.send(sessionId, command),
								),
							orchestrationTools,
							userMcpServers,
						).pipe(Effect.provideService(AttachmentService, attachmentService));
					} else if (input.providerId === "codex") {
						// Same story as Claude: we don't ship the SDK's bundled native
						// CLI, so hand it the user's installed `codex` binary. Surface a
						// clean install message if it's missing instead of the SDK's
						// "Unable to locate Codex CLI binaries" error.
						const codexPath = yield* resolveCliPath("codex", binaryPaths).pipe(
							Effect.provideService(
								CommandExecutor.ChildProcessSpawner,
								executor,
							),
						);
						if (codexPath === null) {
							return yield* Effect.fail(
								new AgentSessionStartError({
									providerId: "codex",
									reason:
										"Codex CLI not found on PATH. Install Codex from https://github.com/openai/codex and try again.",
								}),
							);
						}
						const mcpProxyCommand = yield* resolveCliPath(
							"bun",
							binaryPaths,
						).pipe(
							Effect.provideService(
								CommandExecutor.ChildProcessSpawner,
								executor,
							),
						);
						for (const name of legacyAppOwnedCodexServerNames(
							readNativeServers({
								cwd,
								excludeCodexNames: [],
							}),
						)) {
							try {
								execFileSync(codexPath, ["mcp", "remove", name], {
									stdio: "ignore",
									timeout: 5_000,
								});
							} catch (cause) {
								console.warn(
									`[mcp-migration] could not remove legacy app-owned entry ${name}`,
									cause,
								);
							}
						}
						// We used to also fail-fast here when `codex --version` was below
						// the SDK pin. Pulled because `session.create` calls
						// `provider.start` synchronously — failing at start blocked
						// session creation outright, leaving the user with no surface to
						// upgrade *from*. The renderer's `CliUpgradeBanner` is the
						// canonical signal (driven by the periodic availability probe),
						// and the codex driver translates the SDK's
						// "unexpected argument '--experimental-json'" failure on the
						// first turn into a clean upgrade message — so the user sees
						// either the banner before sending or the friendly error after,
						// never the cryptic SDK trace.
						providerHandle = yield* startCodexSession(
							driverInput,
							cwd,
							apiKey,
							codexPath,
							sessionId,
							buildRequestPermission(input.folderId),
							runtimeModeGetter,
							(command) =>
								Effect.runPromiseWith(runtime)(
									browserBridge.send(sessionId, command),
								),
							mcpProxyCommand ?? process.execPath,
							orchestrationTools,
							resumeCursor,
							() => {
								registry.invalidateIfCurrent(sessionId, generation);
							},
						).pipe(Effect.provideService(AttachmentService, attachmentService));
					} else {
						return yield* Effect.fail(
							new AgentSessionStartError({
								providerId: input.providerId,
								reason: `Provider is unavailable or its extension is disabled: ${input.providerId}`,
							}),
						);
					}
					const handle = yield* makeTurnScopedSessionHandle(
						providerHandle,
						input.initialTurnId,
					);
					const entry: SessionEntry = {
						providerId: input.providerId,
						model: requestedModel,
						handle,
						turnStartedAt: null,
						turnAnalytics: new TurnAnalyticsAccumulator(),
					};
					const accepted = yield* lifecycleWorker.run(
						sessionId,
						Effect.sync(() => registry.publish(sessionId, generation, entry)),
					);
					if (!accepted) {
						yield* handle.close().pipe(Effect.catch(() => Effect.void));
						return { sessionId, superseded: true };
					}
					yield* analytics.capture("provider startup completed", {
						provider: input.providerId,
						model: input.model
							? safeModelId(input.providerId, input.model)
							: "custom",
						duration_ms: Date.now() - startupStartedAt,
						resumed: resumeCursor !== null,
					});
					return { sessionId, generation };
				});
				return startupWorker
					.run(startupKey, startupPermits.withPermits(1)(start))
					.pipe(
						Effect.tapError(() =>
							analytics.capture("provider startup failed", {
								provider: input.providerId,
								model: input.model
									? safeModelId(input.providerId, input.model)
									: "custom",
								duration_ms: Date.now() - startupStartedAt,
								error_code: "startup_failed",
							}),
						),
						Effect.withSpan("provider.start", {
							attributes: {
								"provider.id": input.providerId,
								"provider.model": input.model
									? safeModelId(input.providerId, input.model)
									: "custom",
							},
						}),
					);
			},
			send: (sessionId, turnId, text, attachments, fileRefs, skillRefs) =>
				Effect.flatMap(lookup(sessionId), (entry) =>
					Effect.gen(function* () {
						entry.turnStartedAt = Date.now();
						entry.turnAnalytics = new TurnAnalyticsAccumulator();
						yield* analytics.capture("message submitted", {
							provider: entry.providerId,
							model: entry.model,
							attachment_count: attachments?.length ?? 0,
							input_length_bucket: inputLengthBucket(text.length),
						});
						yield* analytics.capture("turn started", {
							provider: entry.providerId,
							model: entry.model,
						});
						yield* entry.handle.send(
							turnId,
							text,
							attachments,
							fileRefs,
							skillRefs,
						);
					}).pipe(
						Effect.withSpan("provider.send", {
							attributes: {
								"provider.id": entry.providerId,
								"provider.model": entry.model,
								"session.id": sessionId,
							},
						}),
					),
				),
			interrupt: (sessionId, turnId) =>
				Effect.flatMap(lookup(sessionId), (entry) =>
					entry.handle.interrupt(turnId).pipe(
						Effect.tap(() =>
							analytics.capture("turn interrupted", {
								provider: entry.providerId,
								model: entry.model,
								duration_ms:
									entry.turnStartedAt === null
										? 0
										: Date.now() - entry.turnStartedAt,
								...entry.turnAnalytics.snapshot(),
							}),
						),
						Effect.tap(() =>
							Effect.sync(() => {
								entry.turnStartedAt = null;
							}),
						),
						Effect.withSpan("provider.interrupt", {
							attributes: {
								"provider.id": entry.providerId,
								"provider.model": entry.model,
								"session.id": sessionId,
							},
						}),
					),
				),
			close: (sessionId) =>
				lifecycleWorker.run(
					sessionId,
					Effect.flatMap(invalidate(sessionId), (entry) =>
						entry === undefined
							? detachSessionQuestions(sessionId).pipe(
									Effect.andThen(
										Effect.fail(new AgentSessionNotFoundError({ sessionId })),
									),
								)
							: detachSessionQuestions(sessionId).pipe(
									Effect.andThen(entry.handle.close()),
									Effect.withSpan("provider.close", {
										attributes: {
											"provider.id": entry.providerId,
											"provider.model": entry.model,
											"session.id": sessionId,
										},
									}),
								),
					),
				),
			events: (sessionId) =>
				Stream.unwrap(
					Effect.map(lookup(sessionId), (entry) =>
						entry.handle.events.pipe(
							Stream.filterEffect((envelope) => {
								const event = envelope.event;
								if (event._tag === "QuestionCallbackReleased") {
									return detachQuestion(sessionId, event.itemId).pipe(
										Effect.as(false),
									);
								}
								if (event._tag === "UserQuestion") {
									return attachQuestion(
										sessionId,
										event.itemId,
										event.questions,
										entry.handle,
									).pipe(
										Effect.map(
											(admission) =>
												admission === "attached" || admission === "duplicate",
										),
									);
								}
								return Effect.succeed(true);
							}),
							Stream.tap((envelope) => {
								const event = envelope.event;
								if (event._tag === "UsageDelta") {
									return Effect.sync(() => {
										entry.turnAnalytics.recordUsage(event);
									});
								}
								if (event._tag === "ToolUse") {
									const category = classifyTool(event.tool);
									const record = Effect.sync(() => {
										entry.turnAnalytics.recordToolUse(event.itemId, category);
									});
									return category === "subagent"
										? record.pipe(
												Effect.andThen(
													analytics.capture("subagent started", {
														provider: entry.providerId,
														model: entry.model,
													}),
												),
											)
										: record;
								}
								if (event._tag === "ToolResult") {
									return Effect.sync(() => {
										entry.turnAnalytics.recordToolResult(
											event.itemId,
											event.isError,
										);
									});
								}
								if (event._tag === "SubagentSummary") {
									return Effect.sync(() => {
										entry.turnAnalytics.recordSubagentResult(event.isError);
									}).pipe(
										Effect.andThen(
											analytics.capture("subagent completed", {
												provider: entry.providerId,
												model: entry.model,
												outcome: event.isError ? "failed" : "completed",
											}),
										),
									);
								}
								if (
									event._tag === "ContextCompaction" &&
									event.status === "completed"
								) {
									return Effect.sync(() => {
										entry.turnAnalytics.recordCompaction();
									}).pipe(
										Effect.andThen(
											analytics.capture("context compacted", {
												provider: entry.providerId,
												model: entry.model,
												tokens: event.afterTokens ?? 0,
											}),
										),
									);
								}
								if (event._tag === "UsageLimit") {
									return analytics.capture("usage limit reached", {
										provider: event.providerId,
										scope: "provider",
									});
								}
								if (
									event._tag === "Completed" &&
									entry.turnStartedAt !== null
								) {
									const duration = Date.now() - entry.turnStartedAt;
									entry.turnStartedAt = null;
									return analytics.capture(
										event.reason === "ended"
											? "turn completed"
											: event.reason === "interrupted"
												? "turn interrupted"
												: "turn failed",
										{
											provider: entry.providerId,
											model: entry.model,
											duration_ms: duration,
											...entry.turnAnalytics.snapshot(),
											...(event.reason === "error"
												? { error_code: "provider_error" }
												: {}),
										},
									);
								}
								return Effect.void;
							}),
							Stream.filter(isPublicProviderEvent),
						),
					),
				) as Stream.Stream<ProviderEventEnvelope, AgentSessionNotFoundError>,
			acknowledgeProviderEventCursor: (sessionId, cursor) =>
				Effect.flatMap(
					lookup(sessionId),
					({ handle }) =>
						handle.acknowledgeProviderEventCursor?.(cursor) ?? Effect.void,
				),
			releaseProviderEventCursor: (sessionId, cursor) =>
				Effect.flatMap(
					lookup(sessionId),
					({ handle }) =>
						handle.releaseProviderEventCursor?.(cursor) ?? Effect.void,
				),
			updateMcpServers: (sessionId, servers) =>
				Effect.flatMap(
					lookup(sessionId),
					({ handle }) => handle.updateMcpServers?.(servers) ?? Effect.void,
				),
			setCredential: (providerId, apiKey) =>
				Effect.gen(function* () {
					const normalized = apiKey.trim();
					if (providerId === "cursor" && normalized.length === 0) {
						return yield* Effect.fail(
							new CredentialValidationError({
								providerId,
								reason: "Enter an API key before saving.",
							}),
						);
					}
					if (providerId !== "cursor") {
						yield* credentials.set(providerId, normalized);
						yield* Cache.invalidateAll(availabilityCache);
						yield* modelCatalog.invalidateLive(providerId);
						return { verification: "notChecked" as const };
					}
					const validation = yield* validateApiKey(normalized);
					if (validation.status === "invalid") {
						return yield* Effect.fail(
							new CredentialValidationError({
								providerId,
								reason: validation.reason,
							}),
						);
					}
					yield* credentials.set(providerId, normalized);
					yield* Cache.invalidateAll(availabilityCache);
					yield* modelCatalog.invalidateLive(providerId);
					return validation.status === "verified"
						? { verification: "verified" as const }
						: {
								verification: "unverified" as const,
								warning: validation.warning,
							};
				}),
			removeCredential: (providerId) =>
				credentials
					.remove(providerId)
					.pipe(
						Effect.andThen(Cache.invalidateAll(availabilityCache)),
						Effect.andThen(modelCatalog.invalidateLive(providerId)),
					),
			setPermissionMode: (sessionId, mode) =>
				Effect.flatMap(lookup(sessionId), ({ handle }) =>
					handle.setPermissionMode(mode),
				),
			questionAttachments: () =>
				questionAttachmentChanges.stream(() => questionAttachments.snapshot()),
			hasQuestionAttachment: (sessionId, itemId) =>
				Effect.sync(() => questionAttachments.has(sessionId, itemId)),
			validateQuestionAnswer: (sessionId, itemId, answers) =>
				questionAttachments.validateAnswer(sessionId, itemId, answers),
			answerQuestion: (sessionId, itemId, answers) =>
				lifecycleWorker.run(
					sessionId,
					Effect.gen(function* () {
						const { handle, providerId } = yield* lookup(sessionId);
						const descriptor = (yield* extensions.providers()).find(
							(candidate) => candidate.id === providerId,
						);
						if (
							descriptor &&
							!descriptor.capabilities.includes("answerQuestion")
						)
							return yield* new SessionOperationUnsupportedError({
								message: "This extension does not support answering questions.",
							});
						yield* questionAttachments.deliverAnswer(
							sessionId,
							itemId,
							answers,
							handle
								.answerQuestion(itemId, answers)
								.pipe(
									Effect.mapError(
										() => new AgentSessionNotFoundError({ sessionId }),
									),
								),
						);
					}),
				),
			cancelQuestion: (sessionId, itemId) =>
				lifecycleWorker.run(
					sessionId,
					Effect.gen(function* () {
						const { handle } = yield* lookup(sessionId);
						const cancel = handle.cancelQuestion;
						if (cancel === undefined) {
							return yield* new AgentSessionNotFoundError({ sessionId });
						}
						yield* questionAttachments.deliverCancellation(
							sessionId,
							itemId,
							cancel(itemId).pipe(
								Effect.mapError(
									() => new AgentSessionNotFoundError({ sessionId }),
								),
							),
						);
					}),
				),
			acknowledgeQuestionResolution: (sessionId, itemId) =>
				lifecycleWorker.run(
					sessionId,
					Effect.flatMap(
						lookup(sessionId),
						({ handle }) =>
							handle.acknowledgeQuestionAnswer?.(itemId) ?? Effect.void,
					).pipe(
						Effect.catch(() => Effect.void),
						Effect.andThen(detachQuestion(sessionId, itemId)),
						Effect.asVoid,
					),
				),
			respondToPlan: (sessionId, toolCallId, outcome, feedback) =>
				Effect.flatMap(lookup(sessionId), (entry) =>
					(
						entry.handle.respondToPlan?.(toolCallId, outcome, feedback) ??
						Effect.fail(new AgentSessionNotFoundError({ sessionId }))
					).pipe(
						Effect.tap(() =>
							analytics.capture("plan decided", { decision: outcome }),
						),
					),
				),
			getGoal: (sessionId) =>
				Effect.flatMap(lookup(sessionId), ({ handle }) =>
					"getGoal" in handle && typeof handle.getGoal === "function"
						? (handle as unknown as GoalCapableHandle).getGoal()
						: Effect.fail(new AgentSessionNotFoundError({ sessionId })),
				),
			setGoal: (sessionId, goal: ThreadGoalSetInput) =>
				Effect.flatMap(lookup(sessionId), ({ handle }) =>
					"setGoal" in handle && typeof handle.setGoal === "function"
						? (handle as unknown as GoalCapableHandle).setGoal(goal)
						: Effect.fail(new AgentSessionNotFoundError({ sessionId })),
				),
			clearGoal: (sessionId) =>
				Effect.flatMap(lookup(sessionId), ({ handle }) =>
					"clearGoal" in handle && typeof handle.clearGoal === "function"
						? (handle as unknown as GoalCapableHandle).clearGoal()
						: Effect.fail(new AgentSessionNotFoundError({ sessionId })),
				),
		};
	}),
);
