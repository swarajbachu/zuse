import { execFileSync } from "node:child_process";
import { startClaudeSession } from "@zuse/agents/drivers/claude";
import { startCodexSession } from "@zuse/agents/drivers/codex";
import { startCursorSession } from "@zuse/agents/drivers/cursor";
import { startGeminiSession } from "@zuse/agents/drivers/gemini";
import { startGrokSession } from "@zuse/agents/drivers/grok";
import { startOpencodeSession } from "@zuse/agents/drivers/opencode";
import { AttachmentService } from "@zuse/agents/kernel/attachment-service";
import type {
	GoalCapableSessionHandle,
	ProviderSessionHandle,
} from "@zuse/agents/kernel/driver";
import {
	makeTurnScopedSessionHandle,
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
	type AgentSessionId,
	AgentSessionNotFoundError,
	AgentSessionStartError,
	CredentialValidationError,
	DEFAULT_RUNTIME_MODE,
	type FolderId,
	type PermissionDecision,
	type PermissionKind,
	type ProviderEventEnvelope,
	type ProviderId,
	type ThreadGoalSetInput,
} from "@zuse/contracts";
import { KeyedEffectSerialWorker } from "@zuse/utils/keyed-worker";
import { Cache, Effect, FileSystem, Layer, Semaphore, Stream } from "effect";
import { ChildProcessSpawner as CommandExecutor } from "effect/unstable/process";
import { AnalyticsService } from "../../analytics/services/analytics-service.ts";
import { ConfigStoreService } from "../../config-store/services/config-store-service.ts";
import {
	legacyAppOwnedCodexServerNames,
	readNativeServers,
} from "../../mcp/native-config.ts";
import { McpService } from "../../mcp/services/mcp-service.ts";
import { WorkspaceService } from "../../workspace/services/workspace-service.ts";
import { validateApiKey } from "../api-key-validation.ts";
import { probeAllProviders, resolveCliPath } from "../availability.ts";
import { makeProviderSessionRegistry } from "../provider-session-registry.ts";
import { BrowserBridgeService } from "../services/browser-bridge-service.ts";
import { CredentialsService } from "../services/credentials-service.ts";
import { PermissionService } from "../services/permission-service.ts";
import { ProviderService } from "../services/provider-service.ts";

/**
 * Live provider runtime. Handles own their scopes and are published through a
 * generation-checked registry, so an older asynchronous startup cannot replace
 * the provider selected by a newer session command.
 */
type SessionHandle = TurnScopedProviderSessionHandle;

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
		const workspace = yield* WorkspaceService;
		const permissions = yield* PermissionService;
		const attachmentService = yield* AttachmentService;
		const browserBridge = yield* BrowserBridgeService;
		const configStore = yield* ConfigStoreService;
		const mcp = yield* McpService;
		const analytics = yield* AnalyticsService;
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
					const list = yield* probeAllProviders.pipe(
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
					return [...legacyProviders, cursorAvailability];
				}),
		});

		const availability = (refresh = false) =>
			Effect.gen(function* () {
				if (refresh) yield* Cache.invalidate(availabilityCache, "providers");
				return yield* Cache.get(availabilityCache, "providers");
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
					const driverInput = {
						...input,
						workspaceInstructions: zuseWorkspaceInstructions({
							projectPath: folder.path,
							cwd,
						}),
					};
					const apiKey = yield* credentials
						.get(input.providerId)
						.pipe(Effect.catch(() => Effect.succeed<string | null>(null)));
					let providerHandle: ProviderSessionHandle;
					if (input.providerId === "gemini") {
						// Same story as Grok: hand the driver the user's installed
						// `gemini` binary. Surface a clean install message rather than
						// letting spawn fail with ENOENT inside the driver.
						const geminiPath = yield* resolveCliPath("gemini").pipe(
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
						const geminiMcpCommand = yield* resolveCliPath("bun").pipe(
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
					} else if (input.providerId === "grok") {
						// Same story as Claude/Codex: hand the driver the user's
						// installed `grok` binary (no bundled CLI in our package).
						// Surface a clean install message rather than letting spawn
						// fail with ENOENT inside the driver.
						const grokPath = yield* resolveCliPath("grok").pipe(
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
						const mcpProxyCommand = yield* resolveCliPath("bun").pipe(
							Effect.provideService(
								CommandExecutor.ChildProcessSpawner,
								executor,
							),
						);
						if (mcpProxyCommand === null) {
							return yield* Effect.fail(
								new AgentSessionStartError({
									providerId: "grok",
									reason:
										"Bun was not found on PATH. It is required for the MCP compatibility transport.",
								}),
							);
						}
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
							mcpProxyCommand,
							orchestrationTools,
							resumeCursor,
							providerEventCursor,
						).pipe(Effect.provideService(AttachmentService, attachmentService));
					} else if (input.providerId === "opencode") {
						// OpenCode spawns a local HTTP server (`opencode serve`) and we
						// drive it via @opencode-ai/sdk. Same install-message pattern
						// as the other CLI-backed drivers — surface a clean error
						// before the driver tries to spawn.
						const opencodePath = yield* resolveCliPath("opencode").pipe(
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
					} else if (input.providerId === "cursor") {
						if (apiKey === null || apiKey.trim().length === 0) {
							return yield* Effect.fail(
								new AgentSessionStartError({
									providerId: "cursor",
									reason:
										"API key required. Add an API key in provider settings and try again.",
								}),
							);
						}
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
						const claudePath = yield* resolveCliPath("claude").pipe(
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
							apiKey,
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
					} else {
						// Same story as Claude: we don't ship the SDK's bundled native
						// CLI, so hand it the user's installed `codex` binary. Surface a
						// clean install message if it's missing instead of the SDK's
						// "Unable to locate Codex CLI binaries" error.
						const codexPath = yield* resolveCliPath("codex").pipe(
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
						const mcpProxyCommand = yield* resolveCliPath("bun").pipe(
							Effect.provideService(
								CommandExecutor.ChildProcessSpawner,
								executor,
							),
						);
						if (mcpProxyCommand === null) {
							return yield* Effect.fail(
								new AgentSessionStartError({
									providerId: "codex",
									reason:
										"Bun was not found on PATH. It is required for the MCP compatibility transport.",
								}),
							);
						}
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
							mcpProxyCommand,
							orchestrationTools,
							resumeCursor,
						).pipe(Effect.provideService(AttachmentService, attachmentService));
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
							? Effect.fail(new AgentSessionNotFoundError({ sessionId }))
							: entry.handle.close().pipe(
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
					.pipe(Effect.andThen(Cache.invalidateAll(availabilityCache))),
			setPermissionMode: (sessionId, mode) =>
				Effect.flatMap(lookup(sessionId), ({ handle }) =>
					handle.setPermissionMode(mode),
				),
			answerQuestion: (sessionId, itemId, answers) =>
				Effect.flatMap(lookup(sessionId), ({ handle }) =>
					handle.answerQuestion(itemId, answers),
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
				Effect.flatMap(lookup(sessionId), ({ providerId, handle }) =>
					providerId === "codex" || providerId === "grok"
						? (handle as unknown as GoalCapableHandle).getGoal()
						: Effect.fail(new AgentSessionNotFoundError({ sessionId })),
				),
			setGoal: (sessionId, goal: ThreadGoalSetInput) =>
				Effect.flatMap(lookup(sessionId), ({ providerId, handle }) =>
					providerId === "codex" || providerId === "grok"
						? (handle as unknown as GoalCapableHandle).setGoal(goal)
						: Effect.fail(new AgentSessionNotFoundError({ sessionId })),
				),
			clearGoal: (sessionId) =>
				Effect.flatMap(lookup(sessionId), ({ providerId, handle }) =>
					providerId === "codex" || providerId === "grok"
						? (handle as unknown as GoalCapableHandle).clearGoal()
						: Effect.fail(new AgentSessionNotFoundError({ sessionId })),
				),
		};
	}),
);
