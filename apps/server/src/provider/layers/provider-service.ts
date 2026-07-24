import { buildBrowserTools } from "@zuse/agents/drivers/browser-tools";
import { startClaudeSession } from "@zuse/agents/drivers/claude";
import { startCodexSession } from "@zuse/agents/drivers/codex";
import { prewarmCursor, startCursorSession } from "@zuse/agents/drivers/cursor";
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
import { classifyTool, inputLengthBucket, safeModelId } from "@zuse/analytics";
import {
	type AgentAvailability,
	type AgentSessionId,
	AgentSessionNotFoundError,
	AgentSessionStartError,
	DEFAULT_RUNTIME_MODE,
	type FolderId,
	type PermissionDecision,
	type PermissionKind,
	type ProviderEventEnvelope,
	type ProviderId,
	type ThreadGoalSetInput,
} from "@zuse/contracts";
import { Cache, Effect, FileSystem, Layer, Ref, Stream } from "effect";
import { ChildProcessSpawner as CommandExecutor } from "effect/unstable/process";
import { AnalyticsService } from "../../analytics/services/analytics-service.ts";
import { ConfigStoreService } from "../../config-store/services/config-store-service.ts";
import { McpService } from "../../mcp/services/mcp-service.ts";
import { WorkspaceService } from "../../workspace/services/workspace-service.ts";
import { probeAllProviders, resolveCliPath } from "../availability.ts";
import { BrowserBridgeService } from "../services/browser-bridge-service.ts";
import { CredentialsService } from "../services/credentials-service.ts";
import { PermissionService } from "../services/permission-service.ts";
import { ProviderService } from "../services/provider-service.ts";

/**
 * Live `ProviderService`. PR 5 wires the Claude SDK driver behind the session
 * RPCs. Codex (PR 6) lands as a second adapter and the session map will
 * generalize over `providerId` then. For now `start` only knows Claude.
 *
 * Sessions live in a `Ref<Map>` keyed by branded `AgentSessionId`; handles
 * own their own scope so `close()` is the canonical teardown — there is no
 * autocleanup tied to the renderer subscription.
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
	usage: {
		inputTokens: number;
		outputTokens: number;
		cacheReadTokens: number;
		cacheCreationTokens: number;
	};
	readonly tools: Map<
		string,
		{ category: ReturnType<typeof classifyTool>; startedAt: number }
	>;
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
		const sessions = yield* Ref.make<Map<AgentSessionId, SessionEntry>>(
			new Map(),
		);

		// Prewarm a cursor-agent child at layer boot if cursor is installed.
		// The ACP authenticate step is the slowest part of cold start (~8s);
		// having one warm child standing by means the user's first cursor
		// session skips straight to `session/new`. Fire-and-forget — layer
		// construction does not depend on it.
		yield* Effect.forkDetach(
			Effect.gen(function* () {
				const cursorPath = yield* resolveCliPath("cursor-agent").pipe(
					Effect.provideService(CommandExecutor.ChildProcessSpawner, executor),
					Effect.catch(() => Effect.succeed<string | null>(null)),
				);
				if (cursorPath === null) return;
				// Layer construction is part of application startup. Do not touch the
				// OS keychain here: unsigned development builds can trigger a native
				// permission dialog before the user has asked to start a provider.
				// A real Cursor session still resolves and supplies its API key.
				yield* Effect.sync(() => prewarmCursor(cursorPath, null));
			}),
		);

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
					// listConfigured is best-effort — a keychain failure here shouldn't
					// wipe out the CLI-logged-in picture, which is the primary auth path
					// and works without any keychain entry of ours.
					const configured = yield* credentials
						.listConfigured()
						.pipe(
							Effect.catch(() =>
								Effect.succeed([] as ReadonlyArray<ProviderId>),
							),
						);
					const configuredSet = new Set<ProviderId>(configured);
					return list.map(
						(a): AgentAvailability => ({
							...a,
							hasApiKey: configuredSet.has(a.providerId),
						}),
					);
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
			Effect.flatMap(Ref.get(sessions), (map) => {
				const entry = map.get(sessionId);
				return entry === undefined
					? Effect.fail(new AgentSessionNotFoundError({ sessionId }))
					: Effect.succeed(entry);
			});

		return {
			availability,
			start: (
				input,
				resumeCursor = null,
				getRuntimeMode,
				orchestrationTools = null,
				providerEventCursor = null,
			) => {
				const startupStartedAt = Date.now();
				return Effect.gen(function* () {
					if (input.sessionId !== undefined) {
						const requestedSessionId = input.sessionId;
						const existing = (yield* Ref.get(sessions)).get(requestedSessionId);
						if (existing?.providerId === input.providerId) {
							return { sessionId: requestedSessionId };
						}
						if (existing !== undefined) {
							yield* existing.handle
								.close()
								.pipe(Effect.catch(() => Effect.void));
							yield* Ref.update(sessions, (current) => {
								const next = new Map(current);
								next.delete(requestedSessionId);
								return next;
							});
						}
					}
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
					const sessionId = input.sessionId ?? nextSessionId();
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
						// Cursor exposes an ACP server via `cursor-agent acp`. The
						// documented installed binary is `cursor-agent` (not `cursor`);
						// surface a clean install message rather than letting spawn
						// fail with ENOENT inside the driver. Older `cursor-agent`
						// builds (pre-ACP) will instead drop into a TUI and the
						// handshake will time out — that's a separate, also-clean
						// error path from the driver.
						const cursorPath = yield* resolveCliPath("cursor-agent").pipe(
							Effect.provideService(
								CommandExecutor.ChildProcessSpawner,
								executor,
							),
						);
						if (cursorPath === null) {
							return yield* Effect.fail(
								new AgentSessionStartError({
									providerId: "cursor",
									reason:
										"Cursor CLI not found on PATH. Install Cursor Agent from https://cursor.com/install and try again.",
								}),
							);
						}
						providerHandle = yield* startCursorSession(
							driverInput,
							cwd,
							apiKey,
							cursorPath,
							sessionId,
							buildRequestPermission(input.folderId),
							runtimeModeGetter,
							resumeCursor,
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
						// Browser tools drive the renderer's shared `<webview>` through
						// the bridge. Bind `send` to this session id + the live runtime so
						// the SDK's async tool handlers stay free of Effect wiring.
						const browserTools = buildBrowserTools((command) =>
							Effect.runPromiseWith(runtime)(
								browserBridge.send(sessionId, command),
							),
						);

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
							browserTools,
							// Control-plane orchestration tools (when autonomy != off) use
							// their own provider-neutral `zuse-orchestration` MCP server.
							orchestrationTools?.claudeTools ?? [],
							orchestrationTools?.linearTools?.claudeTools ?? [],
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
						const codexMcpCommand = yield* resolveCliPath("bun").pipe(
							Effect.provideService(
								CommandExecutor.ChildProcessSpawner,
								executor,
							),
						);
						if (codexMcpCommand === null) {
							return yield* Effect.fail(
								new AgentSessionStartError({
									providerId: "codex",
									reason:
										"Bun was not found on PATH. It is required for the Codex MCP stdio fallback.",
								}),
							);
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
							codexMcpCommand,
							orchestrationTools,
							codexMcpCommand,
							resumeCursor,
						).pipe(Effect.provideService(AttachmentService, attachmentService));
					}
					const handle = yield* makeTurnScopedSessionHandle(
						providerHandle,
						input.initialTurnId,
					);
					yield* Ref.update(sessions, (map) => {
						const next = new Map(map);
						next.set(sessionId, {
							providerId: input.providerId,
							model: input.model
								? safeModelId(input.providerId, input.model)
								: "custom",
							handle,
							turnStartedAt: null,
							usage: {
								inputTokens: 0,
								outputTokens: 0,
								cacheReadTokens: 0,
								cacheCreationTokens: 0,
							},
							tools: new Map(),
						});
						return next;
					});
					yield* analytics.capture("provider startup completed", {
						provider: input.providerId,
						model: input.model
							? safeModelId(input.providerId, input.model)
							: "custom",
						duration_ms: Date.now() - startupStartedAt,
						resumed: resumeCursor !== null,
					});
					return { sessionId };
				}).pipe(
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
				);
			},
			send: (sessionId, turnId, text, attachments, fileRefs, skillRefs) =>
				Effect.flatMap(lookup(sessionId), (entry) =>
					Effect.gen(function* () {
						entry.turnStartedAt = Date.now();
						entry.usage = {
							inputTokens: 0,
							outputTokens: 0,
							cacheReadTokens: 0,
							cacheCreationTokens: 0,
						};
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
					}),
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
							}),
						),
						Effect.tap(() =>
							Effect.sync(() => {
								entry.turnStartedAt = null;
							}),
						),
					),
				),
			close: (sessionId) =>
				Effect.flatMap(lookup(sessionId), ({ handle }) =>
					handle.close().pipe(
						Effect.andThen(
							Ref.update(sessions, (map) => {
								const next = new Map(map);
								next.delete(sessionId);
								return next;
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
										entry.usage.inputTokens += event.inputTokens;
										entry.usage.outputTokens += event.outputTokens;
										entry.usage.cacheReadTokens += event.cacheReadTokens;
										entry.usage.cacheCreationTokens +=
											event.cacheCreationTokens;
									});
								}
								if (event._tag === "ToolUse") {
									const category = classifyTool(event.tool);
									entry.tools.set(event.itemId, {
										category,
										startedAt: Date.now(),
									});
									return category === "subagent"
										? analytics.capture("subagent started", {
												provider: entry.providerId,
												model: entry.model,
											})
										: Effect.void;
								}
								if (event._tag === "ToolResult") {
									const tool = entry.tools.get(event.itemId);
									entry.tools.delete(event.itemId);
									return analytics.capture("tool used", {
										provider: entry.providerId,
										model: entry.model,
										tool_category: tool?.category ?? "other",
										outcome: event.isError ? "failed" : "completed",
										duration_ms: tool ? Date.now() - tool.startedAt : 0,
									});
								}
								if (event._tag === "SubagentSummary") {
									return analytics.capture("subagent completed", {
										provider: entry.providerId,
										model: entry.model,
										outcome: event.isError ? "failed" : "completed",
									});
								}
								if (
									event._tag === "ContextCompaction" &&
									event.status === "completed"
								) {
									return analytics.capture("context compacted", {
										provider: entry.providerId,
										model: entry.model,
										tokens: event.afterTokens ?? 0,
									});
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
										event.reason === "ended"
											? {
													provider: entry.providerId,
													model: entry.model,
													duration_ms: duration,
													input_tokens: entry.usage.inputTokens,
													output_tokens: entry.usage.outputTokens,
													cache_read_tokens: entry.usage.cacheReadTokens,
													cache_creation_tokens:
														entry.usage.cacheCreationTokens,
												}
											: {
													provider: entry.providerId,
													model: entry.model,
													duration_ms: duration,
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
				credentials
					.set(providerId, apiKey)
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
