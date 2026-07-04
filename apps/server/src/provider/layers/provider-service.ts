import { CommandExecutor, FileSystem } from "@effect/platform";
import { Effect, Layer, Ref, Runtime, Stream } from "effect";

import {
  AgentSessionId,
  AgentSessionNotFoundError,
  AgentSessionStartError,
  DEFAULT_RUNTIME_MODE,
  type AgentAvailability,
  type AgentEvent,
  type FolderId,
  type PermissionDecision,
  type PermissionKind,
  type ProviderId,
  type ThreadGoalSetInput,
} from "@zuse/wire";

import { probeAllProviders, resolveCliPath } from "../availability.ts";
import {
  startClaudeSession,
  type ClaudeSessionHandle,
} from "../drivers/claude.ts";
import {
  startCodexSession,
  type CodexSessionHandle,
} from "../drivers/codex.ts";
import { startGrokSession, type GrokSessionHandle } from "../drivers/grok.ts";
import {
  startGeminiSession,
  type GeminiSessionHandle,
} from "../drivers/gemini.ts";
import {
  prewarmCursor,
  startCursorSession,
  type CursorSessionHandle,
} from "../drivers/cursor.ts";
import {
  startOpencodeSession,
  type OpencodeSessionHandle,
} from "../drivers/opencode.ts";
import { AttachmentService } from "../../attachment/services/attachment-service.ts";
import { buildIndexTools } from "../../code-index/claude-tools.ts";
import { buildBrowserTools } from "../drivers/browser-tools.ts";
import { IndexRegistry } from "../../code-index/services/index-registry.ts";
import { BrowserBridgeService } from "../services/browser-bridge-service.ts";
import { CredentialsService } from "../services/credentials-service.ts";
import { PermissionService } from "../services/permission-service.ts";
import { ProviderService } from "../services/provider-service.ts";
import { WorkspaceService } from "../../workspace/services/workspace-service.ts";

/**
 * Live `ProviderService`. PR 5 wires the Claude SDK driver behind the session
 * RPCs. Codex (PR 6) lands as a second adapter and the session map will
 * generalize over `providerId` then. For now `start` only knows Claude.
 *
 * Sessions live in a `Ref<Map>` keyed by branded `AgentSessionId`; handles
 * own their own scope so `close()` is the canonical teardown — there is no
 * autocleanup tied to the renderer subscription.
 */
type SessionHandle =
  | ClaudeSessionHandle
  | CodexSessionHandle
  | GrokSessionHandle
  | GeminiSessionHandle
  | CursorSessionHandle
  | OpencodeSessionHandle;

/**
 * Handles that expose goal mode. Codex backs it with `thread/goal/*` RPCs;
 * Grok forwards to its native `/goal` slash command with driver-local state.
 * Both share the same method shape so the goal routes treat them uniformly.
 */
type GoalCapableHandle = CodexSessionHandle | GrokSessionHandle;
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
    const executor = yield* CommandExecutor.CommandExecutor;
    const fs = yield* FileSystem.FileSystem;
    const credentials = yield* CredentialsService;
    const workspace = yield* WorkspaceService;
    const permissions = yield* PermissionService;
    const attachmentService = yield* AttachmentService;
    const browserBridge = yield* BrowserBridgeService;
    const indexRegistry = yield* IndexRegistry;
    const runtime = yield* Effect.runtime<never>();
    const sessions = yield* Ref.make<Map<AgentSessionId, SessionEntry>>(
      new Map(),
    );

    // Prewarm a cursor-agent child at layer boot if cursor is installed.
    // The ACP authenticate step is the slowest part of cold start (~8s);
    // having one warm child standing by means the user's first cursor
    // session skips straight to `session/new`. Fire-and-forget — layer
    // construction does not depend on it.
    yield* Effect.forkDaemon(
      Effect.gen(function* () {
        const cursorPath = yield* resolveCliPath("cursor-agent").pipe(
          Effect.provideService(CommandExecutor.CommandExecutor, executor),
          Effect.catchAll(() => Effect.succeed<string | null>(null)),
        );
        if (cursorPath === null) return;
        const apiKey = yield* credentials
          .get("cursor")
          .pipe(Effect.catchAll(() => Effect.succeed<string | null>(null)));
        yield* Effect.sync(() => prewarmCursor(cursorPath, apiKey));
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
        Runtime.runPromise(runtime)(
          permissions.request(sessionId, kind, {
            projectId,
            forcePrompt: options.forcePrompt,
          }),
        );

    const availability = () =>
      Effect.gen(function* () {
        const list = yield* probeAllProviders.pipe(
          Effect.provideService(CommandExecutor.CommandExecutor, executor),
          Effect.provideService(FileSystem.FileSystem, fs),
        );
        // listConfigured is best-effort — a keychain failure here shouldn't
        // wipe out the CLI-logged-in picture, which is the primary auth path
        // and works without any keychain entry of ours.
        const configured = yield* credentials
          .listConfigured()
          .pipe(
            Effect.catchAll(() =>
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
      start: (input, resumeCursor = null, getRuntimeMode) =>
        Effect.gen(function* () {
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
          const apiKey = yield* credentials
            .get(input.providerId)
            .pipe(Effect.catchAll(() => Effect.succeed<string | null>(null)));
          const sessionId = input.sessionId ?? nextSessionId();
          let handle: SessionHandle;
          if (input.providerId === "gemini") {
            // Same story as Grok: hand the driver the user's installed
            // `gemini` binary. Surface a clean install message rather than
            // letting spawn fail with ENOENT inside the driver.
            const geminiPath = yield* resolveCliPath("gemini").pipe(
              Effect.provideService(CommandExecutor.CommandExecutor, executor),
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
            handle = yield* startGeminiSession(
              input,
              cwd,
              apiKey,
              geminiPath,
              sessionId,
              buildRequestPermission(input.folderId),
              runtimeModeGetter,
              resumeCursor,
            ).pipe(Effect.provideService(AttachmentService, attachmentService));
          } else if (input.providerId === "grok") {
            // Same story as Claude/Codex: hand the driver the user's
            // installed `grok` binary (no bundled CLI in our package).
            // Surface a clean install message rather than letting spawn
            // fail with ENOENT inside the driver.
            const grokPath = yield* resolveCliPath("grok").pipe(
              Effect.provideService(CommandExecutor.CommandExecutor, executor),
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
            const bunPath = yield* resolveCliPath("bun").pipe(
              Effect.provideService(CommandExecutor.CommandExecutor, executor),
            );
            if (bunPath === null) {
              return yield* Effect.fail(
                new AgentSessionStartError({
                  providerId: "grok",
                  reason:
                    "Bun was not found on PATH. It is required to expose Zuse browser tools to Grok via ACP MCP.",
                }),
              );
            }
            handle = yield* startGrokSession(
              input,
              cwd,
              apiKey,
              grokPath,
              bunPath,
              sessionId,
              buildRequestPermission(input.folderId),
              runtimeModeGetter,
              (command) =>
                Runtime.runPromise(runtime)(
                  browserBridge.send(sessionId, command),
                ),
              resumeCursor,
            ).pipe(Effect.provideService(AttachmentService, attachmentService));
          } else if (input.providerId === "opencode") {
            // OpenCode spawns a local HTTP server (`opencode serve`) and we
            // drive it via @opencode-ai/sdk. Same install-message pattern
            // as the other CLI-backed drivers — surface a clean error
            // before the driver tries to spawn.
            const opencodePath = yield* resolveCliPath("opencode").pipe(
              Effect.provideService(CommandExecutor.CommandExecutor, executor),
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
            handle = yield* startOpencodeSession(
              input,
              cwd,
              apiKey,
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
              Effect.provideService(CommandExecutor.CommandExecutor, executor),
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
            handle = yield* startCursorSession(
              input,
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
              Effect.provideService(CommandExecutor.CommandExecutor, executor),
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
            // Phase B: resolve the per-worktree IndexService and bind the
            // five Tier-1 tools (code_search, symbol_lookup, find_references,
            // read_chunk, list_module) so the Claude SDK sees them alongside
            // ask_user_question. Branch defaults to "HEAD" — the manifest
            // resolves it; Phase E adds a real git-checkout subscription.
            const indexHandle = yield* indexRegistry.getHandle(cwd, "HEAD");
            const indexTools = buildIndexTools(indexHandle);
            // Browser tools drive the renderer's shared `<webview>` through
            // the bridge. Bind `send` to this session id + the live runtime so
            // the SDK's async tool handlers stay free of Effect wiring (same
            // shape as `buildIndexTools` binding the worktree handle).
            const browserTools = buildBrowserTools((command) =>
              Runtime.runPromise(runtime)(
                browserBridge.send(sessionId, command),
              ),
            );

            handle = yield* startClaudeSession(
              input,
              cwd,
              apiKey,
              claudePath,
              sessionId,
              buildRequestPermission(input.folderId),
              runtimeModeGetter,
              resumeCursor,
              [...indexTools, ...browserTools],
            ).pipe(Effect.provideService(AttachmentService, attachmentService));
          } else {
            // Same story as Claude: we don't ship the SDK's bundled native
            // CLI, so hand it the user's installed `codex` binary. Surface a
            // clean install message if it's missing instead of the SDK's
            // "Unable to locate Codex CLI binaries" error.
            const codexPath = yield* resolveCliPath("codex").pipe(
              Effect.provideService(CommandExecutor.CommandExecutor, executor),
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
              input,
              cwd,
              apiKey,
              codexPath,
              sessionId,
              buildRequestPermission(input.folderId),
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
            Effect.zipRight(
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
      setCredential: (providerId, apiKey) =>
        credentials.set(providerId, apiKey),
      setPermissionMode: (sessionId, mode) =>
        Effect.flatMap(lookup(sessionId), ({ handle }) =>
          handle.setPermissionMode(mode),
        ),
      answerQuestion: (sessionId, itemId, answers) =>
        Effect.flatMap(lookup(sessionId), ({ handle }) =>
          handle.answerQuestion(itemId, answers),
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
