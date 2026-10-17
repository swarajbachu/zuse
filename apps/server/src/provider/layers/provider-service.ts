import { startClaudeSession } from "@zuse/agents/drivers/claude";
import { startCodexSession } from "@zuse/agents/drivers/codex";
import { startCursorSession } from "@zuse/agents/drivers/cursor";
import { startGeminiSession } from "@zuse/agents/drivers/gemini";
import { startGenericAcpSession } from "@zuse/agents/drivers/generic-acp";
import { startGrokSession } from "@zuse/agents/drivers/grok";
import { HtmlTools } from "@zuse/agents/drivers/html-tools";
import { startKiroSession } from "@zuse/agents/drivers/kiro";
import { startOpencodeSession } from "@zuse/agents/drivers/opencode";
import { startOpencode2Session } from "@zuse/agents/drivers/opencode2";
import { startPiSession } from "@zuse/agents/drivers/pi";
import {
	getDefaultPluginClient,
	pluginCliEnv,
} from "@zuse/agents/drivers/plugin-tools";
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
	issueMcpGatewaySession,
	type McpGatewayHttpServer,
	type McpGatewaySession,
} from "@zuse/agents/mcp-gateway";
import {
	classifyTool,
	inputLengthBucket,
	safeModelId,
	TurnAnalyticsAccumulator,
} from "@zuse/analytics";
import {
	AgentAvailability,
	type AgentItemId,
	type AgentSessionId,
	AgentSessionNotFoundError,
	AgentSessionStartError,
	CredentialValidationError,
	DEFAULT_RUNTIME_MODE,
	type FolderId,
	isAcpProviderId,
	type PermissionDecision,
	type PermissionKind,
	type ProviderEventEnvelope,
	type ProviderId,
	providerCapabilities,
	SessionId,
	type UserQuestion,
} from "@zuse/contracts";
import { KeyedEffectSerialWorker } from "@zuse/utils/keyed-worker";
import {
	Cache,
	Effect,
	FileSystem,
	Layer,
	Option,
	Semaphore,
	Stream,
} from "effect";
import { ChildProcessSpawner as CommandExecutor } from "effect/unstable/process";
import { AnalyticsService } from "../../analytics/services/analytics-service.ts";
import { AutomationService } from "../../automation/service.ts";
import { ConfigStoreService } from "../../config-store/services/config-store-service.ts";
import { HarnessProvider } from "../../harness/provider.ts";
import { createHtmlTools } from "../../html-render/service.ts";
import {
	ModelCatalogService,
	toDriverModelDescriptor,
} from "../../model-catalog/services/model-catalog-service.ts";
import { SkillDiscoveryService } from "../../skill/services/skill-discovery.ts";
import {
	claudeSkillAllowlist,
	hasDisabledSkillsFor,
} from "../../skill/skill-enablement.ts";
import { WorkspaceService } from "../../workspace/services/workspace-service.ts";
import { AcpAgentService } from "../acp/service.ts";
import { validateApiKey } from "../api-key-validation.ts";
import {
	probeProvidersWithPaths,
	resolveCliPath,
	withOpencodeInventoryAccount,
} from "../availability.ts";
import {
	bindProviderEventDelivery,
	type ProviderEventDelivery,
} from "../provider-event-delivery.ts";
import {
	type GoalCurrentCheck,
	type GoalPublication,
	runProviderGoal,
} from "../provider-goal.ts";
import {
	closeProviderHandle,
	ownProviderRegistry,
} from "../provider-handle-cleanup.ts";
import { ownProviderInputs } from "../provider-input-identity.ts";
import { sendProviderSession } from "../provider-send.ts";
import { makeProviderSessionRegistry } from "../provider-session-registry.ts";
import {
	acquireStartupHandle,
	reserveProviderStartup,
} from "../provider-startup.ts";
import {
	quiesceProviderSession,
	stopProviderSession,
} from "../provider-stop.ts";
import { makeQuestionAttachmentAuthority } from "../question-attachment-authority.ts";
import { makeQuestionAttachmentSnapshotFeed } from "../question-attachment-feed.ts";
import { BrowserBridgeService } from "../services/browser-bridge-service.ts";
import { CredentialsService } from "../services/credentials-service.ts";
import { PermissionService } from "../services/permission-service.ts";
import { ProviderAccounts } from "../services/provider-accounts.ts";
import { ProviderService } from "../services/provider-service.ts";
import { RuntimeGitExecution } from "../services/runtime-git-execution.ts";
import { RuntimeProviderCredentials } from "../services/runtime-provider-credentials.ts";

type SessionHandle = TurnScopedProviderSessionHandle;

const isPublicProviderEvent = (
	envelope: TurnScopedProviderEventEnvelope,
): envelope is ProviderEventEnvelope =>
	envelope.event._tag !== "QuestionCallbackReleased";

type GoalCapableHandle = GoalCapableSessionHandle;
type SessionEntry = {
	readonly providerSessionId: string;
	readonly providerId: ProviderId;
	readonly model: string;
	readonly ownership?: import("@zuse/contracts").ProviderAttemptOwnership;
	readonly handle: SessionHandle;
	readonly gitExecutionKey?: string;
	turnStartedAt: number | null;
	turnAnalytics: TurnAnalyticsAccumulator;
};

let sessionCounter = 0;
const nextSessionId = (): AgentSessionId =>
	`s_${Date.now()}_${++sessionCounter}` as AgentSessionId;

export const ProviderServiceLive = Layer.effect(
	ProviderService,
	Effect.gen(function* () {
		const acpAgents = yield* AcpAgentService;
		const executor = yield* CommandExecutor.ChildProcessSpawner;
		const fs = yield* FileSystem.FileSystem;
		const harness = yield* Effect.serviceOption(HarnessProvider);
		const credentials = yield* CredentialsService;
		const automation = yield* Effect.serviceOption(AutomationService);
		const accounts = yield* Effect.serviceOption(ProviderAccounts);
		const runtimeCredentials = yield* RuntimeProviderCredentials;
		const gitExecution = yield* RuntimeGitExecution;
		const modelCatalog = yield* ModelCatalogService;
		const workspace = yield* WorkspaceService;
		const permissions = yield* PermissionService;
		const attachmentService = yield* AttachmentService;
		const htmlTools = yield* Effect.acquireRelease(
			Effect.sync(() => createHtmlTools(attachmentService)),
			(tools) => Effect.promise(() => tools.close()),
		);
		const browserBridge = yield* BrowserBridgeService;
		const configStore = yield* ConfigStoreService;
		const skillDiscovery = yield* SkillDiscoveryService;
		const analytics = yield* AnalyticsService;
		const runtime = yield* Effect.context<never>();
		const registry = makeProviderSessionRegistry<
			AgentSessionId,
			SessionEntry
		>();
		yield* ownProviderRegistry(registry);

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
				if (registry.lookup(sessionId)?.handle !== handle) return "conflict";
				const attachment = { sessionId, itemId };
				const admission = questionAttachments.attach(attachment, questions);
				if (admission === "conflict") {
					yield* Effect.logWarning(
						`[ProviderService] suppressed conflicting question metadata for ${sessionId}/${itemId}`,
					);
					return admission;
				}
				if (admission === "duplicate") return admission;
				if (admission === "full") {
					yield* (
						handle.cancelQuestion === undefined
							? handle.close()
							: handle
									.cancelQuestion(itemId)
									.pipe(
										Effect.andThen(
											handle.acknowledgeQuestionAnswer?.(itemId) ?? Effect.void,
										),
									)
					).pipe(
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

		const buildRequestPermission =
			(
				projectId: FolderId,
				authority: Pick<
					import("../services/permission-service.ts").RequestOptions,
					"owner" | "isCurrent"
				>,
			) =>
			(
				sessionId: AgentSessionId,
				kind: PermissionKind,
				options: { readonly forcePrompt: boolean },
			): Promise<PermissionDecision> =>
				Effect.runPromiseWith(runtime)(
					permissions.request(sessionId, kind, {
						...authority,
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
					const accountHomes: Record<string, string> = {};
					const unavailableAccounts = new Set<ProviderId>();
					if (Option.isSome(accounts)) {
						for (const provider of ["claude", "codex"] as const) {
							const selected = yield* accounts.value.selected(provider).pipe(
								Effect.catch(() => {
									unavailableAccounts.add(provider);
									return Effect.succeed(null);
								}),
							);
							if (selected) accountHomes[provider] = selected.home;
						}
					}
					const list = yield* probeProvidersWithPaths(paths, accountHomes).pipe(
						Effect.provideService(
							CommandExecutor.ChildProcessSpawner,
							executor,
						),
						Effect.provideService(FileSystem.FileSystem, fs),
					);

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
								...(unavailableAccounts.has(a.providerId)
									? {
											cliLoggedIn: false,
											authStatus: "unknown" as const,
											status: "error" as const,
											statusMessage:
												"Account storage is unavailable. Try again.",
										}
									: {}),
								hasApiKey: unavailableAccounts.has(a.providerId)
									? false
									: accountHomes[a.providerId]
										? false
										: configuredSet.has(a.providerId),
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
					return [...legacyProviders, cursorAvailability];
				}),
		});

		const availability = (refresh = false) =>
			Effect.gen(function* () {
				const accountService = Option.getOrUndefined(accounts);
				const selections = accountService
					? yield* Effect.all(
							(["claude", "codex"] as const).map((provider) =>
								accountService.list(provider).pipe(
									Effect.map(
										(status) =>
											status.accounts.find((account) => account.preferred)
												?.id ?? null,
									),
									Effect.catch(() => Effect.succeed("unavailable")),
								),
							),
							{ concurrency: "unbounded" },
						)
					: [];
				const key = JSON.stringify([
					(yield* configStore.getSettings()).providerBinaryPaths ?? {},
					selections,
				]);
				if (refresh) yield* Cache.invalidate(availabilityCache, key);
				const probed = yield* Cache.get(availabilityCache, key);
				const catalog = yield* modelCatalog.current();
				const list = [
					...probed.map((entry) =>
						withOpencodeInventoryAccount(
							entry,
							catalog.providers[entry.providerId],
						),
					),
					...(yield* Effect.tryPromise(() => acpAgents.availability()).pipe(
						Effect.catch((error) =>
							Effect.as(
								Effect.logWarning(
									`[provider] ACP agent availability unavailable: ${error}`,
								),
								[],
							),
						),
					)),
				];
				return Option.isSome(harness)
					? [...list, yield* harness.value.availability()]
					: list;
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

		const goalOperation = <A>(
			sessionId: AgentSessionId,
			operation: (handle: GoalCapableHandle) => Effect.Effect<A>,
			options: {
				readonly publish?: GoalPublication<A>;
				readonly notificationDriven?: boolean;
				readonly verify?: GoalCurrentCheck;
				readonly readOnly?: boolean;
			},
		) =>
			Effect.flatMap(lookup(sessionId), (entry) =>
				runProviderGoal({
					registry,
					lifecycle: lifecycleWorker,
					sessionId,
					entry,
					operation,
					...options,
				}),
			);

		return {
			availability,
			hasSession: (sessionId, expectedProviderSessionId) =>
				Effect.sync(() => {
					const entry = registry.lookup(sessionId);
					return (
						entry !== undefined &&
						(expectedProviderSessionId === undefined ||
							entry.providerSessionId === expectedProviderSessionId)
					);
				}),
			quiesce: (sessionId, expectedProviderSessionId) =>
				lifecycleWorker.run(
					sessionId,
					quiesceProviderSession({
						registry,
						sessionId,
						expectedProviderSessionId,
						detachQuestions: detachSessionQuestions(sessionId),
					}),
				),
			captureHistoryCheckpoint: (sessionId) =>
				lifecycleWorker.run(
					sessionId,
					Effect.suspend(
						() =>
							registry.lookup(sessionId)?.handle.captureHistoryCheckpoint?.() ??
							Effect.succeed(null),
					),
				),
			restoreHistoryCheckpoint: (sessionId, checkpoint) =>
				lifecycleWorker.run(
					sessionId,
					Effect.suspend(
						() =>
							registry
								.lookup(sessionId)
								?.handle.restoreHistoryCheckpoint?.(checkpoint) ??
							Effect.succeed(false),
					),
				),
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
				admit,
				providerSessionId,
			) => {
				let managedPlugins: McpGatewaySession | undefined;
				let managedPermissionMode = input.permissionMode ?? "default";
				const startupStartedAt = Date.now();
				const residencyId = providerSessionId ?? crypto.randomUUID();
				const sessionId = input.sessionId ?? nextSessionId();
				const requestedModel = input.model
					? safeModelId(input.providerId, input.model)
					: "custom";
				const startupKey = `${sessionId}\u0000${input.providerId}\u0000${requestedModel}\u0000${input.initialAttemptId ?? ""}\u0000${providerSessionId ?? ""}`;
				const start = Effect.gen(function* () {
					const execution = yield* Effect.tryPromise({
						try: () => gitExecution.resolve(sessionId),
						catch: (cause) =>
							new AgentSessionStartError({
								providerId: input.providerId,
								reason:
									cause instanceof Error
										? cause.message
										: "GitHub connection is unavailable.",
							}),
					});

					const reservation = yield* reserveProviderStartup({
						registry,
						lifecycle: lifecycleWorker,
						sessionId,
						providerSessionId: residencyId,
						admit: admit ?? Effect.succeed(true),
						matches: (existing) =>
							(providerSessionId === undefined ||
								existing.providerSessionId === providerSessionId) &&
							existing.providerId === input.providerId &&
							existing.model === requestedModel &&
							existing.gitExecutionKey === execution?.key &&
							(input.initialAttemptId === undefined ||
								(existing.ownership?.attemptId === input.initialAttemptId &&
									existing.ownership.turnId === input.initialTurnId)),
						detachQuestions: detachSessionQuestions(sessionId),
						closeEntry: (entry) => closeProviderHandle(entry.handle),
					});
					if (reservation._tag === "rejected")
						return { sessionId, superseded: true };
					if (reservation._tag === "reuse") {
						return {
							sessionId,
							generation: reservation.generation,
							providerSessionId: reservation.entry.providerSessionId,
						};
					}
					yield* reservation.releaseDisplaced;
					const generation = reservation.generation;
					const permissionAuthority = {
						isCurrent: Effect.sync(
							() =>
								registry.currentProviderSessionId(sessionId) === residencyId &&
								registry.currentGeneration(sessionId) === generation,
						),
						owner:
							providerSessionId === undefined
								? undefined
								: {
										providerSessionId: residencyId,
										attempt:
											input.initialTurnId === undefined ||
											input.initialAttemptId === undefined
												? undefined
												: {
														turnId: input.initialTurnId,
														attemptId: input.initialAttemptId,
													},
									},
					};
					const binaryPaths =
						(yield* configStore.getSettings()).providerBinaryPaths ?? {};
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
					const account =
						(input.providerId === "claude" || input.providerId === "codex") &&
						Option.isSome(accounts)
							? yield* accounts.value
									.resolve(input.providerId, sessionId, resumeCursor !== null)
									.pipe(
										Effect.mapError(
											(error) =>
												new AgentSessionStartError({
													providerId: input.providerId,
													reason: error.message,
												}),
										),
									)
							: null;
					const secretEnvironment =
						automation._tag === "Some"
							? yield* automation.value
									.secretBindings(SessionId.make(sessionId))
									.pipe(
										Effect.mapError(
											() =>
												new AgentSessionStartError({
													providerId: input.providerId,
													reason:
														"Could not load this session’s private credentials.",
												}),
										),
									)
							: {};
					const driverInput = {
						...input,
						executionEnv: { ...execution?.env, ...secretEnvironment },
						providerAccountHome: account?.home,
						...(canonicalModel !== undefined ? { model: canonicalModel } : {}),
						...(modelDescriptor !== undefined ? { modelDescriptor } : {}),
						workspaceInstructions: zuseWorkspaceInstructions({
							projectPath: folder.path,
							includeAppTools: providerCapabilities(input.providerId).appTools,
							includeOrchestration: orchestrationTools !== null,
							cwd,
						}),
					};
					const brokeredCredential = yield* Effect.tryPromise({
						try: () =>
							account !== null ||
							providerCapabilities(input.providerId).credentialSource ===
								"connections"
								? Promise.resolve(null)
								: runtimeCredentials.resolve(input.providerId),
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
					const managedCredential = account
						? null
						: (brokeredCredential ??
							(yield* credentials
								.getProviderCredential(input.providerId)
								.pipe(Effect.catch(() => Effect.succeed(null)))));
					const apiKey =
						managedCredential?.kind === "api-key"
							? managedCredential.secret
							: null;
					let managedMcp: McpGatewayHttpServer | undefined;
					if (
						["cursor", "opencode", "opencode2", "pi"].includes(input.providerId)
					) {
						managedPlugins = yield* Effect.tryPromise({
							try: async (signal) => {
								const client = await getDefaultPluginClient();
								signal.throwIfAborted();

								const lease = await issueMcpGatewaySession(
									{
										sessionId,
										scopes: {
											browser: false,
											orchestration: orchestrationTools !== null,
											plugins: client !== undefined,
											html: true,
										},
										ctx: {
											html: { client: htmlTools.client, cwd },
											...(orchestrationTools === null
												? {}
												: {
														orchestration: {
															deps: orchestrationTools.deps,
															requestPermission: (kind, options) =>
																buildRequestPermission(
																	input.folderId,
																	permissionAuthority,
																)(sessionId, kind, options),
															getRuntimeMode: () =>
																getRuntimeMode?.() ?? "approval-required",
															getPermissionMode: () => managedPermissionMode,
														},
													}),
											plugins: client
												? {
														client,
														requestPermission: (kind, options) =>
															buildRequestPermission(
																input.folderId,
																permissionAuthority,
															)(sessionId, kind, options),
														getRuntimeMode: () =>
															getRuntimeMode?.() ?? "approval-required",
														getPermissionMode: () => managedPermissionMode,
													}
												: undefined,
										},
									},
									signal,
								);
								if (signal.aborted) {
									await lease.close();
									signal.throwIfAborted();
								}
								managedPlugins = lease;
								return lease;
							},
							catch: () =>
								new AgentSessionStartError({
									providerId: input.providerId,
									reason: "Could not prepare connected plugins",
								}),
						});
						if (managedPlugins) {
							driverInput.executionEnv = {
								...driverInput.executionEnv,
								...pluginCliEnv(managedPlugins.endpoint, managedPlugins.token),
							};
							managedMcp = managedPlugins.httpServer;
						}
					}
					const acquiredHandle = yield* acquireStartupHandle(
						Effect.gen(function* () {
							let providerHandle: ProviderSessionHandle;
							if (isAcpProviderId(input.providerId)) {
								const launch = yield* Effect.tryPromise({
									try: () =>
										acpAgents.launch(input.providerId as `acp-${string}`),
									catch: (cause) =>
										new AgentSessionStartError({
											providerId: input.providerId,
											reason: String(cause),
										}),
								});
								const mcpCommand = yield* resolveCliPath(
									"bun",
									binaryPaths,
								).pipe(
									Effect.provideService(
										CommandExecutor.ChildProcessSpawner,
										executor,
									),
								);
								providerHandle = yield* startGenericAcpSession(
									driverInput,
									cwd,
									launch,
									sessionId,
									buildRequestPermission(input.folderId, permissionAuthority),
									runtimeModeGetter,
									(command) =>
										Effect.runPromiseWith(runtime)(
											browserBridge.send(sessionId, command),
										),
									mcpCommand ?? process.execPath,
									orchestrationTools,
									resumeCursor,
								).pipe(
									Effect.provideService(AttachmentService, attachmentService),
								);
							} else if (input.providerId === "zuse") {
								if (Option.isNone(harness))
									return yield* new AgentSessionStartError({
										providerId: "zuse",
										reason: "Zuse runtime is unavailable.",
									});
								providerHandle = yield* harness.value.start(
									driverInput,
									cwd,
									sessionId,
									resumeCursor,
									runtimeModeGetter,
									permissionAuthority,
									orchestrationTools,
								);
							} else if (input.providerId === "gemini") {
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
									buildRequestPermission(input.folderId, permissionAuthority),
									runtimeModeGetter,
									(command) =>
										Effect.runPromiseWith(runtime)(
											browserBridge.send(sessionId, command),
										),
									geminiMcpCommand,
									orchestrationTools,
									resumeCursor,
								).pipe(
									Effect.provideService(AttachmentService, attachmentService),
								);
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
									managedMcp,
								).pipe(
									Effect.provideService(AttachmentService, attachmentService),
								);
							} else if (input.providerId === "kiro") {
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
									buildRequestPermission(input.folderId, permissionAuthority),
									runtimeModeGetter,
									(command) =>
										Effect.runPromiseWith(runtime)(
											browserBridge.send(sessionId, command),
										),
									kiroMcpCommand,
									orchestrationTools,
									resumeCursor,
								).pipe(
									Effect.provideService(AttachmentService, attachmentService),
								);
							} else if (input.providerId === "grok") {
								const grokPath = yield* resolveCliPath(
									"grok",
									binaryPaths,
								).pipe(
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
									buildRequestPermission(input.folderId, permissionAuthority),
									runtimeModeGetter,
									(command) =>
										Effect.runPromiseWith(runtime)(
											browserBridge.send(sessionId, command),
										),
									mcpProxyCommand ?? process.execPath,
									orchestrationTools,
									resumeCursor,
									providerEventCursor,
								).pipe(
									Effect.provideService(AttachmentService, attachmentService),
								);
							} else if (input.providerId === "opencode") {
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

								const opencodeSettings = yield* configStore.getSettings();
								providerHandle = yield* startOpencodeSession(
									driverInput,
									cwd,
									opencodeSettings.opencodeCustomProviders,
									opencodePath,
									sessionId,
									resumeCursor,
									managedMcp,
								).pipe(
									Effect.provideService(AttachmentService, attachmentService),
								);
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
									buildRequestPermission(input.folderId, permissionAuthority),
									managedMcp,
								).pipe(
									Effect.provideService(AttachmentService, attachmentService),
								);
							} else if (input.providerId === "cursor") {
								providerHandle = yield* startCursorSession(
									driverInput,
									cwd,
									apiKey,
									sessionId,
									resumeCursor,
									managedMcp,
								).pipe(
									Effect.provideService(AttachmentService, attachmentService),
								);
							} else if (input.providerId === "claude") {
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

								const skillAllowlist = hasDisabledSkillsFor(
									(yield* configStore.getSettings()).disabledSkills,
									"claude",
								)
									? claudeSkillAllowlist(
											yield* skillDiscovery.discover("claude", cwd),
										)
									: undefined;

								providerHandle = yield* startClaudeSession(
									driverInput,
									cwd,
									managedCredential,
									claudePath,
									sessionId,
									buildRequestPermission(input.folderId, permissionAuthority),
									runtimeModeGetter,
									resumeCursor,
									(command) =>
										Effect.runPromiseWith(runtime)(
											browserBridge.send(sessionId, command),
										),
									orchestrationTools,
									skillAllowlist,
									providerEventCursor,
								).pipe(
									Effect.provideService(AttachmentService, attachmentService),
								);
							} else {
								const codexPath = yield* resolveCliPath(
									"codex",
									binaryPaths,
								).pipe(
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

								providerHandle = yield* startCodexSession(
									driverInput,
									cwd,
									apiKey,
									codexPath,
									sessionId,
									buildRequestPermission(input.folderId, permissionAuthority),
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
								).pipe(
									Effect.provideService(AttachmentService, attachmentService),
								);
							}

							if (managedPlugins) {
								const underlying = providerHandle;
								const lease = managedPlugins;
								providerHandle = {
									...underlying,
									close: () =>
										underlying
											.close()
											.pipe(
												Effect.ensuring(Effect.promise(() => lease.close())),
											),
									setPermissionMode: (mode) =>
										underlying.setPermissionMode(mode).pipe(
											Effect.tap(() =>
												Effect.sync(() => {
													managedPermissionMode = mode;
												}),
											),
										),
								};
							}

							return providerHandle;
						}),
						{
							close: closeProviderHandle,
							abandon: Effect.sync(() => {
								registry.invalidateIfCurrent(sessionId, generation);
							}),
						},
					);
					const providerHandle = ownProviderInputs(acquiredHandle.handle);
					const handle = yield* makeTurnScopedSessionHandle(
						providerHandle,
						input.initialTurnId,
						input.initialAttemptId,
					);
					const entry: SessionEntry = {
						gitExecutionKey: execution?.key,
						providerSessionId: residencyId,
						ownership:
							input.initialTurnId === undefined ||
							input.initialAttemptId === undefined
								? undefined
								: {
										turnId: input.initialTurnId,
										attemptId: input.initialAttemptId,
									},
						providerId: input.providerId,
						model: requestedModel,
						handle,
						turnStartedAt: null,
						turnAnalytics: new TurnAnalyticsAccumulator(),
					};
					const accepted = yield* lifecycleWorker.run(
						sessionId,
						(admit ?? Effect.succeed(true)).pipe(
							Effect.flatMap((admitted) =>
								Effect.sync(() => {
									const published =
										admitted && registry.publish(sessionId, generation, entry);
									if (published) acquiredHandle.markPublished();
									return published;
								}),
							),
						),
					);
					if (!accepted) {
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
					return {
						sessionId,
						generation,
						providerSessionId: entry.providerSessionId,
						nativeResumeFallback: providerHandle.nativeResumeFallback,
					};
				}).pipe(Effect.scoped);
				return startupWorker
					.run(
						startupKey,
						startupPermits.withPermits(1)(
							start.pipe(
								Effect.provideService(HtmlTools, htmlTools.client),
								Effect.onError(() =>
									Effect.promise(async () => {
										await managedPlugins?.close();
									}),
								),
							),
						),
					)
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
			send: (
				sessionId,
				turnId,
				text,
				attachments,
				fileRefs,
				skillRefs,
				attemptId,
				goal,
			) =>
				Effect.flatMap(lookup(sessionId), (entry) =>
					Effect.gen(function* () {
						const execution = yield* Effect.tryPromise({
							try: () => gitExecution.resolve(sessionId),
							catch: () => new AgentSessionNotFoundError({ sessionId }),
						});
						if (registry.lookup(sessionId) !== entry)
							return yield* new AgentSessionNotFoundError({ sessionId });
						if (entry.gitExecutionKey !== execution?.key) {
							yield* lifecycleWorker.run(
								sessionId,
								Effect.sync(() =>
									registry.lookup(sessionId) === entry
										? registry.invalidate(sessionId)
										: undefined,
								),
							);
							yield* closeProviderHandle(entry.handle);
							return yield* new AgentSessionNotFoundError({ sessionId });
						}
						yield* sendProviderSession({
							registry,
							sessionId,
							entry,
							ownership:
								attemptId === undefined ? undefined : { turnId, attemptId },
							prepare: Effect.gen(function* () {
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
							}),
							send: () =>
								goal !== undefined
									? entry.handle.sendGoal(turnId, goal, text)
									: entry.handle.send(
											turnId,
											text,
											attachments,
											fileRefs,
											skillRefs,
										),
						});
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
			interrupt: (sessionId, turnId, attemptId) =>
				Effect.flatMap(lookup(sessionId), (entry) =>
					Effect.suspend(
						(): Effect.Effect<void, AgentSessionNotFoundError> =>
							attemptId !== undefined &&
							(entry.ownership?.attemptId !== attemptId ||
								entry.ownership.turnId !== turnId)
								? Effect.fail(new AgentSessionNotFoundError({ sessionId }))
								: entry.handle.interrupt(turnId),
					).pipe(
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
			close: (sessionId, ownership, expectedProviderSessionId) =>
				lifecycleWorker.run(
					sessionId,
					stopProviderSession({
						registry,
						sessionId,
						ownership,
						expectedProviderSessionId,
						detachQuestions: detachSessionQuestions(sessionId),
					}).pipe(
						Effect.flatMap((retired) =>
							retired._tag === "retired" && retired.entry === undefined
								? Effect.fail(new AgentSessionNotFoundError({ sessionId }))
								: Effect.void,
						),
						Effect.withSpan("provider.close", {
							attributes: { "session.id": sessionId },
						}),
					),
				),

			events: (sessionId) =>
				Stream.unwrap(
					Effect.map(lookup(sessionId), (entry) =>
						entry.handle.events.pipe(
							Stream.filter(() => registry.lookup(sessionId) === entry),
							Stream.filterEffect((envelope) => {
								const event = envelope.event;
								if (event._tag === "UserQuestionResolved") {
									return detachQuestion(sessionId, event.itemId).pipe(
										Effect.as(true),
									);
								}
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
							Stream.map((envelope) =>
								bindProviderEventDelivery(
									entry.handle,
									envelope,
									entry.providerSessionId,
								),
							),
						),
					),
				) as Stream.Stream<ProviderEventDelivery, AgentSessionNotFoundError>,
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
				Effect.gen(function* () {
					const { handle } = yield* lookup(sessionId);
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
			cancelQuestion: (sessionId, itemId) =>
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
			acknowledgePlanResponse: (sessionId, itemId) =>
				lifecycleWorker.run(
					sessionId,
					Effect.flatMap(
						lookup(sessionId),
						({ handle }) =>
							handle.acknowledgePlanResponse?.(itemId) ?? Effect.void,
					).pipe(Effect.catch(() => Effect.void)),
				),

			respondToPlan: (sessionId, toolCallId, outcome, feedback) =>
				Effect.flatMap(lookup(sessionId), (entry) =>
					(
						entry.handle.respondToPlan?.(toolCallId, outcome, feedback) ??
						Effect.fail(new AgentSessionNotFoundError({ sessionId }))
					).pipe(
						Effect.mapError(() => new AgentSessionNotFoundError({ sessionId })),
						Effect.tap(() =>
							analytics.capture("plan decided", { decision: outcome }),
						),
					),
				),
			getGoal: (sessionId, publish, verify) =>
				goalOperation(sessionId, (handle) => handle.getGoal(), {
					publish,
					verify,
					readOnly: true,
				}),
			setGoal: (sessionId, goal, publish, verify) =>
				goalOperation(sessionId, (handle) => handle.setGoal(goal), {
					publish,
					verify,
					notificationDriven: true,
				}),
			clearGoal: (sessionId, publish, verify) =>
				goalOperation(sessionId, (handle) => handle.clearGoal(), {
					publish,
					verify,
					notificationDriven: true,
				}),
		};
	}),
);
