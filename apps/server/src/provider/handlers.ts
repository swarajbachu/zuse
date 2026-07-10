import {
  AgentSessionStartError,
  CredentialStoreError,
  MemoizeRpcs,
  type ProviderId,
} from "@zuse/contracts";
import { ChildProcessSpawner as CommandExecutor } from "effect/unstable/process";
import { Effect, Layer, Stream } from "effect";

import { ConfigStoreService } from "../config-store/services/config-store-service.ts";
import { resolveCliPath, resolveUpdateCommand } from "./availability.ts";
import {
  loadOpencodeInventory,
  removeOpencodeProviderAuth,
  setOpencodeProviderAuth,
} from "./drivers/opencode.ts";
import { BrowserBridgeService } from "./services/browser-bridge-service.ts";
import { CredentialsService } from "./services/credentials-service.ts";
import { startProviderLogin } from "./services/login-service.ts";
import { startProviderUpdate } from "./services/update-service.ts";
import { MessageStore } from "./services/message-store.ts";
import { PermissionService } from "./services/permission-service.ts";
import { ProviderService } from "./services/provider-service.ts";

/**
 * Provider-domain RPC handlers. Each subsequent PR adds a `toLayerHandler`
 * here as it registers its RPC into `MemoizeRpcs` (in `@zuse/contracts`):
 *
 *   PR 3 — `agent.availability`         ← here
 *   PR 4 — `agent.setCredential`        ← here
 *   PR 5/6 — `agent.start` / `send` / `interrupt` / `close` / `events`
 */
const Availability = MemoizeRpcs.toLayerHandler("agent.availability", () =>
  Effect.flatMap(ProviderService, (svc) => svc.availability()),
);

const SetCredential = MemoizeRpcs.toLayerHandler(
  "agent.setCredential",
  ({ providerId, apiKey }) =>
    Effect.flatMap(ProviderService, (svc) =>
      svc.setCredential(providerId, apiKey).pipe(
        Effect.catchTag("CredentialsError", (err) =>
          Effect.fail(
            new CredentialStoreError({
              providerId: err.providerId as ProviderId,
              reason: err.reason,
            }),
          ),
        ),
      ),
    ),
);

const Start = MemoizeRpcs.toLayerHandler("agent.start", (input) =>
  Effect.flatMap(ProviderService, (svc) => svc.start(input)),
);

const Send = MemoizeRpcs.toLayerHandler("agent.send", ({ sessionId, text }) =>
  Effect.flatMap(ProviderService, (svc) => svc.send(sessionId, text)),
);

const Interrupt = MemoizeRpcs.toLayerHandler(
  "agent.interrupt",
  ({ sessionId, turnId }) =>
    Effect.flatMap(ProviderService, (svc) => svc.interrupt(sessionId, turnId)),
);

const Close = MemoizeRpcs.toLayerHandler("agent.close", ({ sessionId }) =>
  Effect.flatMap(ProviderService, (svc) => svc.close(sessionId)),
);

const Events = MemoizeRpcs.toLayerHandler("agent.events", ({ sessionId }) =>
  Stream.unwrap(Effect.map(ProviderService, (svc) => svc.events(sessionId))),
);

// Renderer subscribes to this when the user clicks the "Sign in" button on a
// provider card or in an auth error bubble. `cursor` and `claude` have real
// handlers — they spawn the provider's `login` subcommand, extract the OAuth
// URL, and stream progress back. When the renderer unsubscribes (cancel,
// navigate away, IPC drop), the stream's scope closes and the child process is
// SIGTERM'd by the service's finalizer.
const StartLogin = MemoizeRpcs.toLayerHandler(
  "agent.startLogin",
  ({ providerId }) => startProviderLogin(providerId),
);

// Renderer subscribes to this when the user clicks "Update" on a provider
// card. Spawns the provider's install/upgrade command in a login shell,
// streams output, and ends with `done`. On success the renderer re-probes
// availability so the new version shows immediately.
const UpdateProvider = MemoizeRpcs.toLayerHandler(
  "agent.updateProvider",
  ({ providerId }) =>
    Stream.unwrap(
      resolveUpdateCommand(providerId).pipe(
        Effect.map((command) => startProviderUpdate(providerId, command)),
      ),
    ),
);

// Renderer calls this on first open of the opencode model picker to refresh
// the static `MODELS_BY_PROVIDER.opencode` seed list with whatever
// providers and agents the user actually has connected/configured. We
// short-live an `opencode serve` for the SDK calls and tear it down on
// return so we don't leave a server lingering.
const OpencodeInventory = MemoizeRpcs.toLayerHandler(
  "agent.opencodeInventory",
  () =>
    Effect.gen(function* () {
      const opencodePath = yield* requireOpencodePath();
      const settings = yield* ConfigStoreService.pipe(
        Effect.flatMap((cs) => cs.getSettings()),
      );
      return yield* loadOpencodeInventory(
        opencodePath,
        process.cwd(),
        settings.opencodeCustomProviders,
      );
    }),
);

// ---------------------------------------------------------------------------
// OpenCode provider management. `setProviderAuth` / `addCustomProvider` write
// credentials through to opencode's own `auth.json` (so terminal opencode sees
// them too); custom-provider *shapes* are persisted to our settings.json
// (`opencodeCustomProviders`) and injected into every `opencode serve` spawn.
// ---------------------------------------------------------------------------

const requireOpencodePath = (): Effect.Effect<
  string,
  AgentSessionStartError,
  CommandExecutor.ChildProcessSpawner
> =>
  Effect.gen(function* () {
    const opencodePath = yield* resolveCliPath("opencode");
    if (opencodePath === null) {
      return yield* Effect.fail(
        new AgentSessionStartError({
          providerId: "opencode",
          reason:
            "OpenCode CLI not found on PATH. Install via `curl -fsSL https://opencode.ai/install | bash` and try again.",
        }),
      );
    }
    return opencodePath;
  });

const OpencodeSetProviderAuth = MemoizeRpcs.toLayerHandler(
  "agent.opencodeSetProviderAuth",
  ({ providerId, apiKey }) =>
    Effect.gen(function* () {
      const opencodePath = yield* requireOpencodePath();
      yield* setOpencodeProviderAuth(
        opencodePath,
        process.cwd(),
        providerId,
        apiKey,
      );
    }),
);

const OpencodeRemoveProviderAuth = MemoizeRpcs.toLayerHandler(
  "agent.opencodeRemoveProviderAuth",
  ({ providerId }) => removeOpencodeProviderAuth(providerId),
);

const OpencodeAddCustomProvider = MemoizeRpcs.toLayerHandler(
  "agent.opencodeAddCustomProvider",
  ({ id, name, baseURL, npm, apiKey, models }) =>
    Effect.gen(function* () {
      const opencodePath = yield* requireOpencodePath();
      const configStore = yield* ConfigStoreService;
      // Write the key through to opencode's auth.json first — if that fails we
      // don't want an orphaned provider def with no credential.
      yield* setOpencodeProviderAuth(opencodePath, process.cwd(), id, apiKey);
      const settings = yield* configStore.getSettings();
      const others = settings.opencodeCustomProviders.filter(
        (p) => p.id !== id,
      );
      yield* configStore.updateSettings({
        opencodeCustomProviders: [
          ...others,
          { id, name, baseURL, npm, models: [...models] },
        ],
      });
    }),
);

const OpencodeRemoveCustomProvider = MemoizeRpcs.toLayerHandler(
  "agent.opencodeRemoveCustomProvider",
  ({ id }) =>
    Effect.gen(function* () {
      const configStore = yield* ConfigStoreService;
      yield* removeOpencodeProviderAuth(id);
      const settings = yield* configStore.getSettings();
      yield* configStore.updateSettings({
        opencodeCustomProviders: settings.opencodeCustomProviders.filter(
          (p) => p.id !== id,
        ),
      });
    }),
);

// ---------------------------------------------------------------------------
// session.* / messages.* — chat-MVP surface backed by `MessageStore`.
// `agent.*` handlers above stay live (renderer no longer calls them, but the
// store composes them and they're useful for low-level testing).
// ---------------------------------------------------------------------------

const SessionList = MemoizeRpcs.toLayerHandler(
  "session.list",
  ({ projectId, includeArchived }) =>
    Effect.flatMap(MessageStore, (svc) =>
      svc.listSessions(projectId, includeArchived ?? false),
    ),
);

const SessionGet = MemoizeRpcs.toLayerHandler("session.get", ({ sessionId }) =>
  Effect.flatMap(MessageStore, (svc) => svc.getSession(sessionId)),
);

const SessionCreate = MemoizeRpcs.toLayerHandler("session.create", (input) =>
  Effect.flatMap(MessageStore, (svc) =>
    svc.createSession({
      chatId: input.chatId,
      providerId: input.providerId,
      model: input.model,
      title: input.title,
      initialPrompt: input.initialPrompt,
      runtimeMode: input.runtimeMode,
      agents: input.agents,
      enableSubagents: input.enableSubagents,
      permissionMode: input.permissionMode,
      modelOptions: input.modelOptions,
      toolSearch: input.toolSearch,
      // Detach `provider.start` so the new in-chat tab appears in
      // ~hundreds of ms; the booting status flips when the CLI handshake
      // finishes (or fails). Chat-create stays synchronous to preserve
      // its existing staged loading panel timing.
      background: true,
    }),
  ),
);

const ChatList = MemoizeRpcs.toLayerHandler(
  "chat.list",
  ({ projectId, includeArchived }) =>
    Effect.flatMap(MessageStore, (svc) =>
      svc.listChats(projectId, includeArchived ?? false),
    ),
);

const ChatGet = MemoizeRpcs.toLayerHandler("chat.get", ({ chatId }) =>
  Effect.flatMap(MessageStore, (svc) => svc.getChat(chatId)),
);

const ChatCreate = MemoizeRpcs.toLayerHandler("chat.create", (input) =>
  Effect.flatMap(MessageStore, (svc) =>
    svc.createChat({
      projectId: input.projectId,
      providerId: input.providerId,
      model: input.model,
      title: input.title,
      initialPrompt: input.initialPrompt,
      runtimeMode: input.runtimeMode,
      worktreeId: input.worktreeId ?? null,
      agents: input.agents,
      enableSubagents: input.enableSubagents,
      permissionMode: input.permissionMode,
      modelOptions: input.modelOptions,
      toolSearch: input.toolSearch,
      originSessionId: input.originSessionId ?? null,
    }),
  ),
);

const ChatRename = MemoizeRpcs.toLayerHandler(
  "chat.rename",
  ({ chatId, title }) =>
    Effect.flatMap(MessageStore, (svc) => svc.renameChat(chatId, title)),
);

const ChatMarkRead = MemoizeRpcs.toLayerHandler("chat.markRead", ({ chatId }) =>
  Effect.flatMap(MessageStore, (svc) => svc.markChatRead(chatId)),
);

const ChatStreamChanges = MemoizeRpcs.toLayerHandler(
  "chat.streamChanges",
  ({ projectId }) =>
    Stream.unwrap(
      Effect.map(MessageStore, (svc) => svc.streamChatChanges(projectId)),
    ),
);

const ChatSetWorktree = MemoizeRpcs.toLayerHandler(
  "chat.setWorktree",
  ({ chatId, worktreeId }) =>
    Effect.flatMap(MessageStore, (svc) =>
      svc.setChatWorktree(chatId, worktreeId),
    ),
);

const ChatSetActiveSession = MemoizeRpcs.toLayerHandler(
  "chat.setActiveSession",
  ({ chatId, sessionId }) =>
    Effect.flatMap(MessageStore, (svc) =>
      svc.setChatActiveSession(chatId, sessionId),
    ),
);

const ChatArchive = MemoizeRpcs.toLayerHandler(
  "chat.archive",
  ({ chatId, force }) =>
    Effect.flatMap(MessageStore, (svc) =>
      svc.archiveChat(chatId, force ?? false),
    ),
);

const ChatUnarchive = MemoizeRpcs.toLayerHandler(
  "chat.unarchive",
  ({ chatId }) =>
    Effect.flatMap(MessageStore, (svc) => svc.unarchiveChat(chatId)),
);

const ChatDelete = MemoizeRpcs.toLayerHandler("chat.delete", ({ chatId }) =>
  Effect.flatMap(MessageStore, (svc) => svc.deleteChat(chatId)),
);

const SessionRename = MemoizeRpcs.toLayerHandler(
  "session.rename",
  ({ sessionId, title }) =>
    Effect.flatMap(MessageStore, (svc) => svc.renameSession(sessionId, title)),
);

const SessionSetModel = MemoizeRpcs.toLayerHandler(
  "session.setModel",
  ({ sessionId, model }) =>
    Effect.flatMap(MessageStore, (svc) => svc.setModel(sessionId, model)),
);

const SessionSetProvider = MemoizeRpcs.toLayerHandler(
  "session.setProvider",
  ({ sessionId, providerId, model }) =>
    Effect.flatMap(MessageStore, (svc) =>
      svc.setProvider(sessionId, providerId, model),
    ),
);

const SessionArchive = MemoizeRpcs.toLayerHandler(
  "session.archive",
  ({ sessionId }) =>
    Effect.flatMap(MessageStore, (svc) => svc.archiveSession(sessionId)),
);

const SessionUnarchive = MemoizeRpcs.toLayerHandler(
  "session.unarchive",
  ({ sessionId }) =>
    Effect.flatMap(MessageStore, (svc) => svc.unarchiveSession(sessionId)),
);

const SessionDelete = MemoizeRpcs.toLayerHandler(
  "session.delete",
  ({ sessionId }) =>
    Effect.flatMap(MessageStore, (svc) => svc.deleteSession(sessionId)),
);

const SessionResume = MemoizeRpcs.toLayerHandler(
  "session.resume",
  ({ sessionId }) =>
    Effect.flatMap(MessageStore, (svc) => svc.resumeSession(sessionId)),
);

const SessionFork = MemoizeRpcs.toLayerHandler("session.fork", (input) =>
  Effect.flatMap(MessageStore, (svc) =>
    svc.forkSession({
      sourceSessionId: input.sourceSessionId,
      fromMessageId: input.fromMessageId,
      destination: input.destination,
      providerId: input.providerId,
      model: input.model,
      worktreeId: input.worktreeId,
      title: input.title,
    }),
  ),
);

const SessionExportTranscript = MemoizeRpcs.toLayerHandler(
  "session.exportTranscript",
  ({ sessionId, uptoMessageId }) =>
    Effect.flatMap(MessageStore, (svc) =>
      svc
        .exportTranscript(sessionId, uptoMessageId)
        .pipe(Effect.map((markdown) => ({ markdown }))),
    ),
);

const SessionLatestPlan = MemoizeRpcs.toLayerHandler(
  "session.latestPlan",
  ({ sessionId }) =>
    Effect.flatMap(MessageStore, (svc) =>
      svc.latestPlan(sessionId).pipe(Effect.map((plan) => ({ plan }))),
    ),
);

const SessionSetRuntimeMode = MemoizeRpcs.toLayerHandler(
  "session.setRuntimeMode",
  ({ sessionId, runtimeMode }) =>
    Effect.flatMap(MessageStore, (svc) =>
      svc.setRuntimeMode(sessionId, runtimeMode),
    ),
);

const SessionSetPermissionMode = MemoizeRpcs.toLayerHandler(
  "session.setPermissionMode",
  ({ sessionId, mode }) =>
    Effect.flatMap(MessageStore, (svc) =>
      svc.setPermissionMode(sessionId, mode),
    ),
);

const SessionAnswerQuestion = MemoizeRpcs.toLayerHandler(
  "session.answerQuestion",
  ({ sessionId, itemId, answers }) =>
    Effect.flatMap(MessageStore, (svc) =>
      svc.answerQuestion(
        sessionId,
        itemId as import("@zuse/contracts").AgentItemId,
        answers,
      ),
    ),
);

const SessionSetWorktree = MemoizeRpcs.toLayerHandler(
  "session.setWorktree",
  ({ sessionId, worktreeId }) =>
    Effect.flatMap(MessageStore, (svc) =>
      svc.setWorktree(sessionId, worktreeId),
    ),
);

const MessagesList = MemoizeRpcs.toLayerHandler(
  "messages.list",
  ({ sessionId }) =>
    Effect.flatMap(MessageStore, (svc) => svc.listMessages(sessionId)),
);

const MessagesStream = MemoizeRpcs.toLayerHandler(
  "messages.stream",
  ({ sessionId, sinceSequence }) =>
    Stream.unwrap(
      Effect.map(MessageStore, (svc) =>
        svc.streamMessages(sessionId, sinceSequence),
      ),
    ),
);

const SessionStreamStatus = MemoizeRpcs.toLayerHandler(
  "session.streamStatus",
  ({ sessionId }) =>
    Stream.unwrap(
      Effect.map(MessageStore, (svc) => svc.streamStatus(sessionId)),
    ),
);

const SessionGoalGet = MemoizeRpcs.toLayerHandler(
  "session.goal.get",
  ({ sessionId }) =>
    Effect.flatMap(MessageStore, (svc) => svc.getGoal(sessionId)),
);

const SessionGoalSet = MemoizeRpcs.toLayerHandler(
  "session.goal.set",
  ({ sessionId, goal }) =>
    Effect.flatMap(MessageStore, (svc) => svc.setGoal(sessionId, goal)),
);

const SessionGoalClear = MemoizeRpcs.toLayerHandler(
  "session.goal.clear",
  ({ sessionId }) =>
    Effect.flatMap(MessageStore, (svc) => svc.clearGoal(sessionId)),
);

const SessionGoalStream = MemoizeRpcs.toLayerHandler(
  "session.goal.stream",
  ({ sessionId }) =>
    Stream.unwrap(Effect.map(MessageStore, (svc) => svc.streamGoal(sessionId))),
);

const MessagesSend = MemoizeRpcs.toLayerHandler(
  "messages.send",
  ({ sessionId, text, input, asGoal, clientMessageId }) => {
    console.log(
      `[rpc.messages.send] sessionId=${sessionId} hasInput=${input !== undefined} attachments=${
        input?.attachments?.length ?? 0
      } fileRefs=${input?.fileRefs?.length ?? 0} skillRefs=${
        input?.skillRefs?.length ?? 0
      } textLen=${(input?.text ?? text ?? "").length}`,
    );
    if (input?.attachments !== undefined && input.attachments.length > 0) {
      console.log(
        `[rpc.messages.send] attachments: ${JSON.stringify(input.attachments)}`,
      );
    }
    return Effect.flatMap(MessageStore, (svc) =>
      svc.sendMessage(
        sessionId,
        input?.text ?? text ?? "",
        input?.attachments,
        input?.fileRefs,
        input?.skillRefs,
        input?.annotations,
        asGoal,
        clientMessageId,
      ),
    );
  },
);

const MessagesInterrupt = MemoizeRpcs.toLayerHandler(
  "messages.interrupt",
  ({ sessionId }) =>
    Effect.flatMap(MessageStore, (svc) => svc.interruptSession(sessionId)),
);

const MessagesQueueList = MemoizeRpcs.toLayerHandler(
  "messages.queue.list",
  ({ sessionId }) =>
    Effect.flatMap(MessageStore, (svc) => svc.listQueuedMessages(sessionId)),
);

const MessagesQueueStream = MemoizeRpcs.toLayerHandler(
  "messages.queue.stream",
  ({ sessionId }) =>
    Stream.unwrap(
      Effect.map(MessageStore, (svc) => svc.streamQueuedMessages(sessionId)),
    ),
);

const MessagesQueueAdd = MemoizeRpcs.toLayerHandler(
  "messages.queue.add",
  ({ sessionId, input }) =>
    Effect.flatMap(MessageStore, (svc) =>
      svc.addQueuedMessage(sessionId, input),
    ),
);

const MessagesQueueUpdate = MemoizeRpcs.toLayerHandler(
  "messages.queue.update",
  ({ sessionId, queueId, input }) =>
    Effect.flatMap(MessageStore, (svc) =>
      svc.updateQueuedMessage(sessionId, queueId, input),
    ),
);

const MessagesQueueDelete = MemoizeRpcs.toLayerHandler(
  "messages.queue.delete",
  ({ sessionId, queueId }) =>
    Effect.flatMap(MessageStore, (svc) =>
      svc.deleteQueuedMessage(sessionId, queueId),
    ),
);

const MessagesQueueSendNow = MemoizeRpcs.toLayerHandler(
  "messages.queue.sendNow",
  ({ sessionId, queueId }) =>
    Effect.flatMap(MessageStore, (svc) =>
      svc.sendQueuedMessageNow(sessionId, queueId),
    ),
);

const MessagesQueueReorder = MemoizeRpcs.toLayerHandler(
  "messages.queue.reorder",
  ({ sessionId, queueIds }) =>
    Effect.flatMap(MessageStore, (svc) =>
      svc.reorderQueuedMessages(sessionId, queueIds),
    ),
);

const MessagesQueueFlush = MemoizeRpcs.toLayerHandler(
  "messages.queue.flush",
  ({ sessionId }) =>
    Effect.flatMap(MessageStore, (svc) => svc.flushQueuedMessages(sessionId)),
);

const MessagesQueueResume = MemoizeRpcs.toLayerHandler(
  "messages.queue.resume",
  ({ sessionId }) =>
    Effect.flatMap(MessageStore, (svc) => svc.resumeQueuedMessages(sessionId)),
);

// ---------------------------------------------------------------------------
// permission.* — Phase 4 surface. The renderer subscribes to
// `permission.requests`, shows a toast, and posts back via `permission.decide`.
// `listPending` is the cold-load helper used on session mount.
// ---------------------------------------------------------------------------

const PermissionRequests = MemoizeRpcs.toLayerHandler(
  "permission.requests",
  () => Stream.unwrap(Effect.map(PermissionService, (svc) => svc.requests())),
);

const PermissionDecide = MemoizeRpcs.toLayerHandler(
  "permission.decide",
  ({ requestId, decision }) =>
    Effect.flatMap(PermissionService, (svc) => svc.decide(requestId, decision)),
);

const PermissionListPending = MemoizeRpcs.toLayerHandler(
  "permission.listPending",
  ({ sessionId }) =>
    Effect.flatMap(PermissionService, (svc) => svc.listPending(sessionId)),
);

const PermissionListDecisions = MemoizeRpcs.toLayerHandler(
  "permission.listDecisions",
  ({ projectId }) =>
    Effect.flatMap(PermissionService, (svc) =>
      svc.listDecisions({ projectId }),
    ),
);

const PermissionRevokeDecision = MemoizeRpcs.toLayerHandler(
  "permission.revokeDecision",
  ({ requestId }) =>
    Effect.flatMap(PermissionService, (svc) => svc.revokeDecision(requestId)),
);

// ---------------------------------------------------------------------------
// browser.* — in-app agent browser bridge. The renderer's BrowserPane
// subscribes to `browser.commands`, drives the `<webview>`, and posts the
// outcome back via `browser.respond`, resolving the Deferred the MCP browser
// tool is awaiting. Mirrors the permission.* request/decide pair.
// ---------------------------------------------------------------------------

const BrowserCommands = MemoizeRpcs.toLayerHandler("browser.commands", () =>
  Stream.unwrap(Effect.map(BrowserBridgeService, (svc) => svc.commands())),
);

const BrowserRespond = MemoizeRpcs.toLayerHandler(
  "browser.respond",
  ({ result }) =>
    Effect.flatMap(BrowserBridgeService, (svc) => svc.respond(result)),
);

// Browser credentials — DUMMY/TEST logins kept in the keychain. A keychain
// failure is swallowed to a safe value (void / [] / null) rather than
// surfacing a defect: a missing credential just means autofill no-ops.
const BrowserSetCredential = MemoizeRpcs.toLayerHandler(
  "browser.setCredential",
  ({ origin, username, password }) =>
    Effect.flatMap(CredentialsService, (svc) =>
      svc.setBrowser(origin, username, password),
    ).pipe(Effect.catch(() => Effect.void)),
);

const BrowserListCredentials = MemoizeRpcs.toLayerHandler(
  "browser.listCredentials",
  () =>
    Effect.flatMap(CredentialsService, (svc) => svc.listBrowser()).pipe(
      Effect.catch(() => Effect.succeed([])),
    ),
);

const BrowserRemoveCredential = MemoizeRpcs.toLayerHandler(
  "browser.removeCredential",
  ({ origin }) =>
    Effect.flatMap(CredentialsService, (svc) => svc.removeBrowser(origin)).pipe(
      Effect.catch(() => Effect.void),
    ),
);

const BrowserFillForOrigin = MemoizeRpcs.toLayerHandler(
  "browser.fillForOrigin",
  ({ origin }) =>
    Effect.flatMap(CredentialsService, (svc) => svc.getBrowser(origin)).pipe(
      Effect.catch(() => Effect.succeed(null)),
    ),
);

export const ProviderHandlersLayer = Layer.mergeAll(
  Availability,
  SetCredential,
  Start,
  Send,
  Interrupt,
  Close,
  Events,
  StartLogin,
  UpdateProvider,
  OpencodeInventory,
  OpencodeSetProviderAuth,
  OpencodeRemoveProviderAuth,
  OpencodeAddCustomProvider,
  OpencodeRemoveCustomProvider,
  SessionList,
  SessionGet,
  SessionCreate,
  SessionRename,
  SessionSetModel,
  SessionSetProvider,
  SessionArchive,
  SessionUnarchive,
  SessionDelete,
  ChatList,
  ChatGet,
  ChatCreate,
  ChatRename,
  ChatMarkRead,
  ChatStreamChanges,
  ChatSetWorktree,
  ChatSetActiveSession,
  ChatArchive,
  ChatUnarchive,
  ChatDelete,
  SessionResume,
  SessionFork,
  SessionExportTranscript,
  SessionLatestPlan,
  SessionSetRuntimeMode,
  SessionSetPermissionMode,
  SessionAnswerQuestion,
  SessionSetWorktree,
  SessionStreamStatus,
  SessionGoalGet,
  SessionGoalSet,
  SessionGoalClear,
  SessionGoalStream,
  MessagesList,
  MessagesStream,
  MessagesSend,
  MessagesInterrupt,
  MessagesQueueList,
  MessagesQueueStream,
  MessagesQueueAdd,
  MessagesQueueUpdate,
  MessagesQueueDelete,
  MessagesQueueSendNow,
  MessagesQueueReorder,
  MessagesQueueFlush,
  MessagesQueueResume,
  PermissionRequests,
  PermissionDecide,
  PermissionListPending,
  PermissionListDecisions,
  PermissionRevokeDecision,
  BrowserCommands,
  BrowserRespond,
  BrowserSetCredential,
  BrowserListCredentials,
  BrowserRemoveCredential,
  BrowserFillForOrigin,
);
