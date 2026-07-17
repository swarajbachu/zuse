import { buildBrowserTools } from "@zuse/agents/drivers/browser-tools";
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
import { zuseWorkspaceInstructions } from "@zuse/agents/kernel/workspace-instructions";
import {
  AgentAvailability,
  type AgentEvent,
  type AgentSessionId,
  AgentSessionNotFoundError,
  AgentSessionStartError,
  CredentialValidationError,
  DEFAULT_RUNTIME_MODE,
  type FolderId,
  type PermissionDecision,
  type PermissionKind,
  type ProviderId,
  type ThreadGoalSetInput,
} from "@zuse/contracts";
import { Cache, Effect, FileSystem, Layer, Ref, Stream } from "effect";
import { ChildProcessSpawner as CommandExecutor } from "effect/unstable/process";
import { ConfigStoreService } from "../../config-store/services/config-store-service.ts";
import { McpService } from "../../mcp/services/mcp-service.ts";
import { WorkspaceService } from "../../workspace/services/workspace-service.ts";
import { validateApiKey } from "../api-key-validation.ts";
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
type SessionHandle = ProviderSessionHandle;

/**
 * Handles that expose goal mode. Codex backs it with `thread/goal/*` RPCs;
 * Grok forwards to its native `/goal` slash command with driver-local state.
 * Both share the same method shape so the goal routes treat them uniformly.
 */
type GoalCapableHandle = GoalCapableSessionHandle;
type SessionEntry = {
  readonly providerId: ProviderId;
  readonly handle: SessionHandle;
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
    const runtime = yield* Effect.context<never>();
    const sessions = yield* Ref.make<Map<AgentSessionId, SessionEntry>>(
      new Map(),
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
          // Keychain enumeration is best-effort for providers that still
          // support CLI authentication. The API-key-only provider is overlaid
          // below from the actual stored credential and never trusts CLI login.
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

          const legacyProviders = yield* Effect.forEach(
            list.filter((item) => item.providerId !== "cursor"),
            (a): Effect.Effect<AgentAvailability> => {
              return Effect.succeed({
                ...a,
                runtimeKind: "cli" as const,
                runtimeAvailable: a.cliInstalled,
                hasApiKey: configuredSet.has(a.providerId),
              });
            },
            { concurrency: "unbounded" },
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
      ) =>
        Effect.gen(function* () {
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
          let handle: SessionHandle;
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
            handle = yield* startGeminiSession(
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
            handle = yield* startGrokSession(
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
            handle = yield* startOpencodeSession(
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
            handle = yield* startCursorSession(
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
            // Browser tools drive the renderer's shared `<webview>` through
            // the bridge. Bind `send` to this session id + the live runtime so
            // the SDK's async tool handlers stay free of Effect wiring.
            const browserTools = buildBrowserTools((command) =>
              Effect.runPromiseWith(runtime)(
                browserBridge.send(sessionId, command),
              ),
            );

            const userMcpServers = yield* mcp.resolveForClaudeSession(cwd);

            handle = yield* startClaudeSession(
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
            handle = yield* startCodexSession(
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
          yield* Ref.update(sessions, (map) => {
            const next = new Map(map);
            next.set(sessionId, { providerId: input.providerId, handle });
            return next;
          });
          return { sessionId };
        }),
      send: (sessionId, text, attachments, fileRefs, skillRefs) =>
        Effect.flatMap(lookup(sessionId), ({ handle }) =>
          handle.send(text, attachments, fileRefs, skillRefs),
        ),
      interrupt: (sessionId) =>
        Effect.flatMap(lookup(sessionId), ({ handle }) => handle.interrupt()),
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
          Effect.map(lookup(sessionId), ({ handle }) => handle.events),
        ) as Stream.Stream<AgentEvent, AgentSessionNotFoundError>,
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
        Effect.flatMap(
          lookup(sessionId),
          ({ handle }) =>
            handle.respondToPlan?.(toolCallId, outcome, feedback) ??
            Effect.fail(new AgentSessionNotFoundError({ sessionId })),
        ),
      getGoal: (sessionId) =>
        Effect.flatMap(lookup(sessionId), ({ providerId, handle }) =>
          providerId === "codex" || providerId === "grok"
            ? (handle as GoalCapableHandle).getGoal()
            : Effect.fail(new AgentSessionNotFoundError({ sessionId })),
        ),
      setGoal: (sessionId, goal: ThreadGoalSetInput) =>
        Effect.flatMap(lookup(sessionId), ({ providerId, handle }) =>
          providerId === "codex" || providerId === "grok"
            ? (handle as GoalCapableHandle).setGoal(goal)
            : Effect.fail(new AgentSessionNotFoundError({ sessionId })),
        ),
      clearGoal: (sessionId) =>
        Effect.flatMap(lookup(sessionId), ({ providerId, handle }) =>
          providerId === "codex" || providerId === "grok"
            ? (handle as GoalCapableHandle).clearGoal()
            : Effect.fail(new AgentSessionNotFoundError({ sessionId })),
        ),
    };
  }),
);
