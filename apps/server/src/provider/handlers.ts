import {
	loadOpencodeInventory,
	removeOpencodeProviderAuth,
	setOpencodeProviderAuth,
} from "@zuse/agents/drivers/opencode";
import { safeModelId } from "@zuse/analytics";
import {
	AgentSessionStartError,
	type ChatCreationOperation,
	ChatId,
	ComposerInput,
	CredentialStoreError,
	FolderId,
	MemoizeRpcs,
	type ProviderId,
	SessionAlreadyStartedError,
	SessionId,
	SessionNotFoundError,
	SessionStartError,
	type SessionSummaryChange,
	type SessionTimelineFrame,
	WorktreeId,
} from "@zuse/contracts";
import { SessionDomain } from "@zuse/domain/engine/session-domain";
import { GitService } from "@zuse/git/git-service";
import { WorktreeService } from "@zuse/git/worktree-service";
import { KeyedEffectSerialWorker } from "@zuse/utils/keyed-worker";
import { Effect, Layer, Result, Schedule, Stream } from "effect";
import type { ChildProcessSpawner as CommandExecutor } from "effect/unstable/process";
import { SqlClient } from "effect/unstable/sql";
import { AnalyticsService } from "../analytics/services/analytics-service.ts";
import { ConfigStoreService } from "../config-store/services/config-store-service.ts";
import {
	timelineEventFromDomain,
	timelineSnapshotFromEvents,
} from "../conversation/core/conversation-timeline-projection.ts";
import {
	ChatService,
	MessageService,
	QueueService,
	SessionService,
	TranscriptService,
} from "../conversation/services/conversation-services.ts";
import { resolveCliPath, resolveUpdateCommand } from "./availability.ts";
import { BrowserBridgeService } from "./services/browser-bridge-service.ts";
import { CredentialsService } from "./services/credentials-service.ts";
import { startProviderLogin } from "./services/login-service.ts";
import { PermissionService } from "./services/permission-service.ts";
import { ProviderService } from "./services/provider-service.ts";
import { startProviderUpdate } from "./services/update-service.ts";

/**
 * Provider-domain RPC handlers. Each subsequent PR adds a `toLayerHandler`
 * here as it registers its RPC into `MemoizeRpcs` (in `@zuse/contracts`):
 *
 * Provider process management stays behind this boundary while session
 * lifecycle and event traffic use the durable session domain.
 */
const Availability = MemoizeRpcs.toLayerHandler(
	"provider.availability",
	({ refresh }) =>
		Effect.flatMap(ProviderService, (svc) => svc.availability(refresh)),
);

const SetCredential = MemoizeRpcs.toLayerHandler(
	"provider.setCredential",
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

const RemoveCredential = MemoizeRpcs.toLayerHandler(
	"provider.removeCredential",
	({ providerId }) =>
		Effect.flatMap(ProviderService, (svc) =>
			svc.removeCredential(providerId).pipe(
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

// Renderer subscribes to this when the user clicks the "Sign in" button on a
// provider card or in an auth error bubble. Supported handlers spawn the
// provider's login subcommand, extract its OAuth URL, and stream progress
// back. When the renderer unsubscribes, the service finalizer stops the child.
const StartLogin = MemoizeRpcs.toLayerHandler(
	"provider.startLogin",
	({ providerId }) => startProviderLogin(providerId),
);

// Renderer subscribes to this when the user clicks "Update" on a provider
// card. Spawns the provider's install/upgrade command in a login shell,
// streams output, and ends with `done`. On success the renderer re-probes
// availability so the new version shows immediately.
const UpdateProvider = MemoizeRpcs.toLayerHandler(
	"provider.update",
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
	"provider.opencode.inventory",
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
	"provider.opencode.setAuth",
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
	"provider.opencode.removeAuth",
	({ providerId }) => removeOpencodeProviderAuth(providerId),
);

const OpencodeAddCustomProvider = MemoizeRpcs.toLayerHandler(
	"provider.opencode.addCustom",
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
	"provider.opencode.removeCustom",
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
// session.* / messages.* — focused conversation service surfaces.
// ---------------------------------------------------------------------------

const SessionList = MemoizeRpcs.toLayerHandler(
	"session.list",
	({ projectId, includeArchived }) =>
		Effect.flatMap(SessionService, (svc) =>
			svc.listSessions(projectId, includeArchived ?? false),
		),
);

const SessionGet = MemoizeRpcs.toLayerHandler("session.get", ({ sessionId }) =>
	Effect.flatMap(SessionService, (svc) => svc.getSession(sessionId)),
);

const SessionStreamChanges = MemoizeRpcs.toLayerHandler(
	"session.streamChanges",
	({ projectId }) =>
		Stream.unwrap(
			Effect.gen(function* () {
				const sessions = yield* SessionService;
				const domain = yield* SessionDomain;
				const snapshotCursor = yield* domain.currentSequence.pipe(Effect.orDie);
				const allSessions = yield* sessions.listSessions(projectId, true);
				const snapshot = allSessions.filter(
					(session) => session.archivedAt === null,
				);
				const known = new Set(
					allSessions.map((session) => session.id as string),
				);
				const summaryEvents = new Set([
					"SessionTitleSet",
					"SessionModelSet",
					"SessionProviderSet",
					"SessionRuntimeModeSet",
					"SessionPermissionModeSet",
					"SessionWorktreeSet",
					"SessionStatusSet",
					"SessionResumeSet",
					"SessionArchived",
					"SessionUnarchived",
				]);
				const live = domain.allEvents({ afterSequence: snapshotCursor }).pipe(
					Stream.filter((record) => {
						if (
							record.event._tag === "SessionCreated" &&
							record.event.projectId === projectId
						) {
							known.add(record.streamId);
							return true;
						}
						return (
							known.has(record.streamId) && summaryEvents.has(record.event._tag)
						);
					}),
					Stream.filterMapEffect(
						(
							record,
						): Effect.Effect<
							Result.Result<SessionSummaryChange, undefined>
						> => {
							if (record.event._tag === "SessionArchived") {
								return Effect.succeed(
									Result.succeed({
										_tag: "remove" as const,
										sequence: record.sequence,
										sessionId: record.streamId as SessionId,
									}),
								);
							}
							return sessions.getSession(record.streamId as never).pipe(
								Effect.map((session) =>
									Result.succeed({
										_tag: "change" as const,
										sequence: record.sequence,
										session,
									}),
								),
								Effect.catch(() => Effect.succeed(Result.fail(undefined))),
							);
						},
					),
				);
				return Stream.concat(
					Stream.succeed({
						_tag: "snapshot" as const,
						cursor: snapshotCursor,
						sessions: snapshot,
					}),
					live,
				);
			}),
		).pipe(Stream.orDie),
);

const SessionCreate = MemoizeRpcs.toLayerHandler("session.create", (input) =>
	Effect.gen(function* () {
		const svc = yield* SessionService;
		const analytics = yield* AnalyticsService;
		const result = yield* svc.createSession({
			sessionId: input.sessionId,
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
		});
		yield* analytics.capture("session created", {
			provider: input.providerId,
			model: safeModelId(input.providerId, input.model),
			runtime_mode: input.runtimeMode ?? "unknown",
			permission_mode: input.permissionMode ?? "default",
		});
		return result;
	}),
);

const ChatList = MemoizeRpcs.toLayerHandler(
	"chat.list",
	({ projectId, includeArchived }) =>
		Effect.flatMap(ChatService, (svc) =>
			svc.listChats(projectId, includeArchived ?? false),
		),
);

const ChatGet = MemoizeRpcs.toLayerHandler("chat.get", ({ chatId }) =>
	Effect.flatMap(ChatService, (svc) => svc.getChat(chatId)),
);

const ChatArchivePreview = MemoizeRpcs.toLayerHandler(
	"chat.archivePreview",
	({ chatId }) =>
		Effect.flatMap(ChatService, (svc) => svc.getArchivePreview(chatId)),
);

const chatCreationWorker = new KeyedEffectSerialWorker<string>();

type ChatCreationOperationRow = {
	readonly operation_id: string;
	readonly chat_id: string;
	readonly initial_session_id: string;
	readonly project_id: string;
	readonly provider_id: string;
	readonly model: string;
	readonly title: string | null;
	readonly runtime_mode: string;
	readonly permission_mode: string;
	readonly tool_search: number;
	readonly prompt: string | null;
	readonly startup_input_json: string | null;
	readonly startup_queue_id: string | null;
	readonly workspace_policy: ChatCreationOperation["workspacePolicy"]["_tag"];
	readonly worktree_id: string | null;
	readonly status: ChatCreationOperation["status"];
	readonly error: string | null;
	readonly created_at: string;
	readonly updated_at: string;
};

const chatCreationOperationFromRow = (
	row: ChatCreationOperationRow,
): ChatCreationOperation => ({
	operationId: row.operation_id,
	chatId: ChatId.make(row.chat_id),
	initialSessionId: SessionId.make(row.initial_session_id),
	projectId: FolderId.make(row.project_id),
	providerId: row.provider_id as ProviderId,
	model: row.model,
	title: row.title,
	runtimeMode: row.runtime_mode as ChatCreationOperation["runtimeMode"],
	permissionMode:
		row.permission_mode as ChatCreationOperation["permissionMode"],
	toolSearch: row.tool_search === 1,
	prompt: row.prompt,
	startupInput:
		row.startup_input_json === null
			? null
			: ComposerInput.make(JSON.parse(row.startup_input_json)),
	startupQueueId: row.startup_queue_id,
	workspacePolicy:
		row.workspace_policy === "fresh"
			? { _tag: "fresh" }
			: row.workspace_policy === "existing" && row.worktree_id !== null
				? { _tag: "existing", worktreeId: WorktreeId.make(row.worktree_id) }
				: { _tag: "main" },
	worktreeId:
		row.worktree_id === null ? null : WorktreeId.make(row.worktree_id),
	status: row.status,
	error: row.error,
	createdAt: new Date(row.created_at),
	updatedAt: new Date(row.updated_at),
});

const listChatCreationOperations = (projectId: string) =>
	Effect.flatMap(SqlClient.SqlClient, (sql) =>
		sql<ChatCreationOperationRow>`
			SELECT operation_id, chat_id, initial_session_id, project_id,
			       provider_id, model, title, runtime_mode, permission_mode,
			       tool_search, prompt, startup_input_json, startup_queue_id,
			       workspace_policy, worktree_id,
			       status, error, created_at, updated_at
			FROM chat_creation_operations
			WHERE project_id = ${projectId}
			  AND (
			    status <> 'succeeded'
			    OR updated_at >= strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-10 minutes')
			  )
			ORDER BY created_at ASC
		`.pipe(
			Effect.orDie,
			Effect.map((rows) => rows.map(chatCreationOperationFromRow)),
		),
	);

const ChatCreate = MemoizeRpcs.toLayerHandler("chat.create", (input) =>
	chatCreationWorker.run(
		input.operationId ?? input.chatId ?? crypto.randomUUID(),
		Effect.gen(function* () {
			const creationStartedAt = Date.now();
			const svc = yield* ChatService;
			const analytics = yield* AnalyticsService;
			const sql = yield* SqlClient.SqlClient;
			const requestedPolicy =
				input.workspacePolicy?._tag ??
				(input.worktreeId === null || input.worktreeId === undefined
					? "main"
					: "existing");
			const policy =
				requestedPolicy === "fresh"
					? yield* Effect.flatMap(GitService, (git) =>
							git.isRepository(input.projectId),
						).pipe(
							Effect.map((isRepository) =>
								isRepository ? ("fresh" as const) : ("main" as const),
							),
							Effect.catchTags({
								GitNotARepoError: () => Effect.succeed("main" as const),
								GitNotInstalledError: () => Effect.succeed("main" as const),
							}),
							Effect.mapError(
								(error) =>
									new SessionStartError({
										providerId: input.providerId,
										reason:
											"reason" in error
												? String(error.reason)
												: "The Git repository could not be inspected.",
									}),
							),
						)
					: requestedPolicy;
			if (
				input.operationId !== undefined &&
				input.chatId !== undefined &&
				input.initialSessionId !== undefined
			) {
				const now = new Date().toISOString();
				yield* sql`
				INSERT INTO chat_creation_operations (
					operation_id, chat_id, initial_session_id, project_id,
					provider_id, model, title, runtime_mode, permission_mode,
					tool_search, prompt, startup_input_json, startup_queue_id,
					workspace_policy, worktree_id,
					status, error, created_at, updated_at
				) VALUES (
					${input.operationId}, ${input.chatId}, ${input.initialSessionId},
					${input.projectId}, ${input.providerId}, ${input.model},
					${input.title ?? null}, ${input.runtimeMode ?? "approval-required"},
					${input.permissionMode ?? "default"}, ${input.toolSearch === true ? 1 : 0},
					${input.startupInput?.text ?? null},
					${input.startupInput === undefined ? null : JSON.stringify(input.startupInput)},
					${input.startupQueueId ?? null},
					${policy}, NULL,
					'pending', NULL, ${now}, ${now}
				)
				ON CONFLICT(operation_id) DO NOTHING
			`.pipe(Effect.orDie);
			}
			const operationRows =
				input.operationId === undefined
					? []
					: yield* sql<{
							readonly worktree_id: string | null;
							readonly status: string;
						}>`
						SELECT worktree_id, status
						FROM chat_creation_operations
						WHERE operation_id = ${input.operationId}
						LIMIT 1
					`.pipe(Effect.orDie);
			const durableWorktreeId = operationRows[0]?.worktree_id ?? null;
			if (input.operationId !== undefined && policy === "main") {
				yield* sql`
					UPDATE chat_creation_operations
					SET workspace_policy = 'main', worktree_id = NULL,
					    updated_at = ${new Date().toISOString()}
					WHERE operation_id = ${input.operationId}
				`.pipe(Effect.orDie);
			}
			const worktreeId =
				policy === "fresh"
					? yield* Effect.gen(function* () {
							const requestedId =
								durableWorktreeId === null
									? WorktreeId.make(crypto.randomUUID())
									: WorktreeId.make(durableWorktreeId);
							if (input.operationId !== undefined) {
								yield* sql`
									UPDATE chat_creation_operations
									SET worktree_id = ${requestedId},
									    status = 'creating_workspace', error = NULL,
									    updated_at = ${new Date().toISOString()}
									WHERE operation_id = ${input.operationId}
								`.pipe(Effect.orDie);
							}
							const created = yield* Effect.flatMap(
								WorktreeService,
								(worktrees) =>
									worktrees.create(input.projectId, undefined, requestedId),
							).pipe(
								Effect.mapError(
									(error) =>
										new SessionStartError({
											providerId: input.providerId,
											reason:
												"reason" in error
													? String(error.reason)
													: "The fresh worktree could not be created.",
										}),
								),
								Effect.tapError((error) =>
									input.operationId === undefined
										? Effect.void
										: sql`
												UPDATE chat_creation_operations
												SET status = 'failed', error = ${error.reason},
												    updated_at = ${new Date().toISOString()}
												WHERE operation_id = ${input.operationId}
											`.pipe(Effect.orDie),
								),
							);
							if (input.operationId !== undefined) {
								yield* sql`
									UPDATE chat_creation_operations
									SET worktree_id = ${created.id}, status = 'creating_chat',
									    updated_at = ${new Date().toISOString()}
									WHERE operation_id = ${input.operationId}
								`.pipe(Effect.orDie);
							}
							return created.id;
						})
					: policy === "existing" && input.workspacePolicy?._tag === "existing"
						? input.workspacePolicy.worktreeId
						: policy === "main"
							? null
							: (input.worktreeId ?? null);
			if (input.operationId !== undefined && policy !== "fresh") {
				yield* sql`
				UPDATE chat_creation_operations
				SET worktree_id = ${worktreeId}, status = 'creating_chat',
				    updated_at = ${new Date().toISOString()}
				WHERE operation_id = ${input.operationId}
			`.pipe(Effect.orDie);
			}
			const result = yield* svc
				.createChat({
					chatId: input.chatId,
					initialSessionId: input.initialSessionId,
					projectId: input.projectId,
					providerId: input.providerId,
					model: input.model,
					title: input.title,
					initialPrompt: input.initialPrompt,
					runtimeMode: input.runtimeMode,
					worktreeId,
					agents: input.agents,
					enableSubagents: input.enableSubagents,
					permissionMode: input.permissionMode,
					modelOptions: input.modelOptions,
					toolSearch: input.toolSearch,
					originSessionId: input.originSessionId ?? null,
					background: input.background,
				})
				.pipe(
					Effect.tapError((error) =>
						input.operationId === undefined
							? Effect.void
							: sql`
								UPDATE chat_creation_operations
								SET status = 'failed', error = ${error.reason},
								    updated_at = ${new Date().toISOString()}
								WHERE operation_id = ${input.operationId}
							`.pipe(Effect.orDie),
					),
					Effect.tap(() =>
						input.operationId === undefined
							? Effect.void
							: sql`
									UPDATE chat_creation_operations
									SET status = 'succeeded', error = NULL,
									    updated_at = ${new Date().toISOString()}
									WHERE operation_id = ${input.operationId}
								`.pipe(Effect.orDie),
					),
				);
			yield* analytics.capture("chat created", {
				provider: input.providerId,
				model: safeModelId(input.providerId, input.model),
				runtime_mode: input.runtimeMode ?? "unknown",
			});
			yield* Effect.logInfo(
				`[chat-creation-timing] operation=${input.operationId ?? "legacy"} durable_chat_ack_ms=${Date.now() - creationStartedAt}`,
			);
			return result;
		}),
	),
);

const ChatCreationList = MemoizeRpcs.toLayerHandler(
	"chat.creation.list",
	({ projectId }) => listChatCreationOperations(projectId),
);

const ChatCreationStream = MemoizeRpcs.toLayerHandler(
	"chat.creation.stream",
	({ projectId }) =>
		Stream.fromEffect(listChatCreationOperations(projectId)).pipe(
			Stream.repeat(Schedule.spaced("1 second")),
			Stream.changesWith(
				(previous, next) =>
					previous.length === next.length &&
					previous.every((operation, index) => {
						const candidate = next[index];
						return (
							candidate !== undefined &&
							operation.operationId === candidate.operationId &&
							operation.status === candidate.status &&
							operation.worktreeId === candidate.worktreeId &&
							operation.error === candidate.error &&
							operation.updatedAt.getTime() === candidate.updatedAt.getTime()
						);
					}),
			),
			Stream.flatMap((operations) => Stream.fromIterable(operations)),
		),
);

const ChatCreationDiscard = MemoizeRpcs.toLayerHandler(
	"chat.creation.discard",
	({ operationId }) =>
		Effect.gen(function* () {
			const sql = yield* SqlClient.SqlClient;
			const rows = yield* sql<{ readonly operation_id: string }>`
				SELECT operation_id FROM chat_creation_operations
				WHERE operation_id = ${operationId} AND status <> 'succeeded'
				LIMIT 1
			`.pipe(Effect.orDie);
			if (rows.length === 0) return { discarded: false };
			yield* sql`
				DELETE FROM chat_creation_operations
				WHERE operation_id = ${operationId} AND status <> 'succeeded'
			`.pipe(Effect.orDie);
			return { discarded: true };
		}),
);

const ChatRename = MemoizeRpcs.toLayerHandler(
	"chat.rename",
	({ chatId, title }) =>
		Effect.flatMap(ChatService, (svc) => svc.renameChat(chatId, title)),
);

const ChatMarkRead = MemoizeRpcs.toLayerHandler("chat.markRead", ({ chatId }) =>
	Effect.flatMap(ChatService, (svc) => svc.markChatRead(chatId)),
);

const ChatStreamChanges = MemoizeRpcs.toLayerHandler(
	"chat.streamChanges",
	({ projectId }) =>
		Stream.unwrap(
			Effect.map(ChatService, (svc) => svc.streamChatChanges(projectId)),
		),
);

const ChatSetWorktree = MemoizeRpcs.toLayerHandler(
	"chat.setWorktree",
	({ chatId, worktreeId }) =>
		Effect.flatMap(ChatService, (svc) =>
			svc.setChatWorktree(chatId, worktreeId),
		),
);

const ChatSetActiveSession = MemoizeRpcs.toLayerHandler(
	"chat.setActiveSession",
	({ chatId, sessionId }) =>
		Effect.flatMap(ChatService, (svc) =>
			svc.setChatActiveSession(chatId, sessionId),
		),
);

const ChatArchive = MemoizeRpcs.toLayerHandler(
	"chat.archive",
	({ chatId, force }) =>
		Effect.gen(function* () {
			const svc = yield* ChatService;
			const analytics = yield* AnalyticsService;
			const result = yield* svc.archiveChat(chatId, force ?? false);
			yield* analytics.capture("chat archived", { outcome: "completed" });
			return result;
		}),
);

const ChatArchiveStatus = MemoizeRpcs.toLayerHandler(
	"chat.archiveStatus",
	({ chatId }) =>
		Effect.flatMap(ChatService, (svc) => svc.getArchiveStatus(chatId)),
);

const ChatArchiveJobs = MemoizeRpcs.toLayerHandler(
	"chat.archiveJobs",
	({ projectId }) =>
		Effect.flatMap(ChatService, (svc) => svc.listArchiveJobs(projectId)),
);

const ChatDirectoryStatus = MemoizeRpcs.toLayerHandler(
	"chat.directoryStatus",
	({ chatId }) =>
		Effect.flatMap(ChatService, (svc) => svc.getChatDirectoryStatus(chatId)),
);

const ChatUnarchive = MemoizeRpcs.toLayerHandler(
	"chat.unarchive",
	({ chatId }) =>
		Effect.gen(function* () {
			const svc = yield* ChatService;
			const analytics = yield* AnalyticsService;
			const result = yield* svc.unarchiveChat(chatId);
			yield* analytics.capture("chat restored", { outcome: "completed" });
			return result;
		}),
);

const ChatDelete = MemoizeRpcs.toLayerHandler("chat.delete", ({ chatId }) =>
	Effect.flatMap(ChatService, (svc) => svc.deleteChat(chatId)),
);

const SessionRename = MemoizeRpcs.toLayerHandler(
	"session.rename",
	({ sessionId, title }) =>
		Effect.flatMap(SessionService, (svc) =>
			svc.renameSession(sessionId, title),
		),
);

const SessionSetModel = MemoizeRpcs.toLayerHandler(
	"session.setModel",
	({ sessionId, model }) =>
		Effect.gen(function* () {
			const svc = yield* SessionService;
			const analytics = yield* AnalyticsService;
			const session = yield* svc.getSession(sessionId);
			const result = yield* svc.setModel(sessionId, model);
			yield* analytics.capture("model changed", {
				provider: session.providerId,
				model: safeModelId(session.providerId, model),
			});
			return result;
		}),
);

const SessionSetProvider = MemoizeRpcs.toLayerHandler(
	"session.setProvider",
	({ sessionId, providerId, model }) =>
		Effect.flatMap(SessionService, (svc) =>
			svc.setProvider(sessionId, providerId, model),
		),
);

const SessionArchive = MemoizeRpcs.toLayerHandler(
	"session.archive",
	({ sessionId }) =>
		Effect.flatMap(SessionService, (svc) => svc.archiveSession(sessionId)),
);

const SessionUnarchive = MemoizeRpcs.toLayerHandler(
	"session.unarchive",
	({ sessionId }) =>
		Effect.flatMap(SessionService, (svc) => svc.unarchiveSession(sessionId)),
);

const SessionDelete = MemoizeRpcs.toLayerHandler(
	"session.delete",
	({ sessionId }) =>
		Effect.flatMap(SessionService, (svc) => svc.deleteSession(sessionId)),
);

const SessionResume = MemoizeRpcs.toLayerHandler(
	"session.resume",
	({ sessionId }) =>
		Effect.flatMap(SessionService, (svc) => svc.resumeSession(sessionId)),
);

const SessionFork = MemoizeRpcs.toLayerHandler("session.fork", (input) =>
	Effect.gen(function* () {
		const svc = yield* TranscriptService;
		const analytics = yield* AnalyticsService;
		const result = yield* svc.forkSession({
			sourceSessionId: input.sourceSessionId,
			fromMessageId: input.fromMessageId,
			destination: input.destination,
			providerId: input.providerId,
			model: input.model,
			worktreeId: input.worktreeId,
			title: input.title,
		});
		yield* analytics.capture("session forked", {
			provider: input.providerId ?? "unknown",
			model:
				input.providerId && input.model
					? safeModelId(input.providerId, input.model)
					: "custom",
			fork_mode: input.destination,
		});
		return result;
	}),
);

const SessionExportTranscript = MemoizeRpcs.toLayerHandler(
	"session.exportTranscript",
	({ sessionId, uptoMessageId }) =>
		Effect.flatMap(TranscriptService, (svc) =>
			svc
				.exportTranscript(sessionId, uptoMessageId)
				.pipe(Effect.map((markdown) => ({ markdown }))),
		),
);

const SessionLatestPlan = MemoizeRpcs.toLayerHandler(
	"session.latestPlan",
	({ sessionId }) =>
		Effect.flatMap(TranscriptService, (svc) =>
			svc.latestPlan(sessionId).pipe(Effect.map((plan) => ({ plan }))),
		),
);

const SessionSetRuntimeMode = MemoizeRpcs.toLayerHandler(
	"session.setRuntimeMode",
	({ sessionId, runtimeMode }) =>
		Effect.flatMap(SessionService, (svc) =>
			svc.setRuntimeMode(sessionId, runtimeMode),
		),
);

const SessionSetPermissionMode = MemoizeRpcs.toLayerHandler(
	"session.setPermissionMode",
	({ sessionId, mode }) =>
		Effect.flatMap(SessionService, (svc) =>
			svc.setPermissionMode(sessionId, mode),
		),
);

const SessionAnswerQuestion = MemoizeRpcs.toLayerHandler(
	"session.answerQuestion",
	({ sessionId, itemId, answers }) =>
		Effect.flatMap(SessionService, (svc) =>
			svc.answerQuestion(
				sessionId,
				itemId as import("@zuse/contracts").AgentItemId,
				answers,
			),
		),
);

const SessionPlanRespond = MemoizeRpcs.toLayerHandler(
	"session.plan.respond",
	({ sessionId, toolCallId, outcome, feedback }) =>
		Effect.flatMap(SessionService, (svc) =>
			svc.respondToPlan(
				sessionId,
				toolCallId as import("@zuse/contracts").AgentItemId,
				outcome,
				feedback,
			),
		),
);

const SessionMcpUpdate = MemoizeRpcs.toLayerHandler(
	"session.mcp.update",
	({ sessionId, servers }) =>
		Effect.flatMap(SessionService, (svc) =>
			svc.updateMcpServers(sessionId, servers),
		),
);

const SessionSetWorktree = MemoizeRpcs.toLayerHandler(
	"session.setWorktree",
	({ sessionId, worktreeId }) =>
		Effect.gen(function* () {
			const sessions = yield* SessionService;
			const chats = yield* ChatService;
			const session = yield* sessions.getSession(sessionId);
			yield* chats
				.setChatWorktree(session.chatId, worktreeId)
				.pipe(
					Effect.mapError((error) =>
						error._tag === "ChatAlreadyStartedError"
							? new SessionAlreadyStartedError({ sessionId })
							: new SessionNotFoundError({ sessionId }),
					),
				);
		}),
);

const MessagesList = MemoizeRpcs.toLayerHandler(
	"messages.list",
	({ sessionId }) =>
		Effect.flatMap(MessageService, (svc) => svc.listMessages(sessionId)),
);

const SessionEvents = MemoizeRpcs.toLayerHandler(
	"session.events",
	({ sessionId, afterVersion, hasProjection }) =>
		Stream.unwrap(
			Effect.gen(function* () {
				const sessions = yield* SessionService;
				yield* sessions.getSession(sessionId);
				const domain = yield* SessionDomain;
				return domain
					.synchronizedEvents({
						streamId: sessionId,
						afterVersion,
						hasProjection,
					})
					.pipe(
						Stream.map((frame): SessionTimelineFrame => {
							if (frame.kind === "snapshot") {
								return {
									kind: "snapshot",
									sessionId,
									throughVersion: frame.throughVersion,
									projection: timelineSnapshotFromEvents(
										sessionId,
										frame.events,
									),
								};
							}
							if (frame.kind === "synchronized") {
								return { ...frame, sessionId };
							}
							return {
								kind: "event",
								sessionId,
								streamVersion: frame.record.streamVersion,
								eventId: frame.record.eventId,
								event: timelineEventFromDomain(sessionId, frame.record.event),
							};
						}),
						Stream.orDie,
					);
			}),
		),
);

const SessionEventsHead = MemoizeRpcs.toLayerHandler(
	"session.events.head",
	({ sessionId }) =>
		Effect.gen(function* () {
			const sessions = yield* SessionService;
			yield* sessions.getSession(sessionId);
			const domain = yield* SessionDomain;
			return {
				throughVersion: yield* domain
					.currentStreamVersion(sessionId)
					.pipe(Effect.orDie),
			};
		}),
);

const SessionGoalGet = MemoizeRpcs.toLayerHandler(
	"session.goal.get",
	({ sessionId }) =>
		Effect.flatMap(SessionService, (svc) => svc.getGoal(sessionId)),
);

const SessionGoalSet = MemoizeRpcs.toLayerHandler(
	"session.goal.set",
	({ sessionId, goal }) =>
		Effect.flatMap(SessionService, (svc) => svc.setGoal(sessionId, goal)),
);

const SessionGoalClear = MemoizeRpcs.toLayerHandler(
	"session.goal.clear",
	({ sessionId }) =>
		Effect.flatMap(SessionService, (svc) => svc.clearGoal(sessionId)),
);

const SessionGoalStream = MemoizeRpcs.toLayerHandler(
	"session.goal.stream",
	({ sessionId }) =>
		Stream.unwrap(
			Effect.map(SessionService, (svc) => svc.streamGoal(sessionId)),
		),
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
		return Effect.flatMap(MessageService, (svc) =>
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
		Effect.flatMap(MessageService, (svc) => svc.interruptSession(sessionId)),
);

const MessagesQueueList = MemoizeRpcs.toLayerHandler(
	"messages.queue.list",
	({ sessionId }) =>
		Effect.flatMap(QueueService, (svc) => svc.listQueuedMessages(sessionId)),
);

const MessagesQueueAdd = MemoizeRpcs.toLayerHandler(
	"messages.queue.add",
	({ sessionId, queueId, input, ready, flush }) =>
		Effect.gen(function* () {
			const svc = yield* QueueService;
			const analytics = yield* AnalyticsService;
			const result = yield* svc.addQueuedMessage(
				sessionId,
				input,
				queueId,
				ready,
				flush,
			);
			yield* analytics.capture("queue action performed", { action: "add" });
			return result;
		}),
);

const MessagesQueueUpdate = MemoizeRpcs.toLayerHandler(
	"messages.queue.update",
	({ sessionId, queueId, input }) =>
		Effect.flatMap(QueueService, (svc) =>
			svc.updateQueuedMessage(sessionId, queueId, input),
		),
);

const MessagesQueueDelete = MemoizeRpcs.toLayerHandler(
	"messages.queue.delete",
	({ sessionId, queueId }) =>
		Effect.flatMap(QueueService, (svc) =>
			svc.deleteQueuedMessage(sessionId, queueId),
		),
);

const MessagesQueueRunNext = MemoizeRpcs.toLayerHandler(
	"messages.queue.runNext",
	({ sessionId, queueId }) =>
		Effect.flatMap(QueueService, (svc) =>
			svc.runQueuedMessageNext(sessionId, queueId),
		),
);

const MessagesQueueReorder = MemoizeRpcs.toLayerHandler(
	"messages.queue.reorder",
	({ sessionId, queueIds }) =>
		Effect.flatMap(QueueService, (svc) =>
			svc.reorderQueuedMessages(sessionId, queueIds),
		),
);

const MessagesQueueFlush = MemoizeRpcs.toLayerHandler(
	"messages.queue.flush",
	({ sessionId }) =>
		Effect.flatMap(QueueService, (svc) => svc.flushQueuedMessages(sessionId)),
);

const MessagesQueueResume = MemoizeRpcs.toLayerHandler(
	"messages.queue.resume",
	({ sessionId }) =>
		Effect.flatMap(QueueService, (svc) => svc.resumeQueuedMessages(sessionId)),
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
		Effect.gen(function* () {
			const svc = yield* PermissionService;
			const analytics = yield* AnalyticsService;
			const result = yield* svc.decide(requestId, decision);
			yield* analytics.capture("permission decided", {
				decision: decision._tag,
				tool_category: "other",
			});
			return result;
		}),
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

// Browser credentials — DUMMY/TEST logins kept in the encrypted vault. A vault
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

export const ProviderHandlersLayer = Layer.mergeAll(
	Availability,
	SetCredential,
	RemoveCredential,
	StartLogin,
	UpdateProvider,
	OpencodeInventory,
	OpencodeSetProviderAuth,
	OpencodeRemoveProviderAuth,
	OpencodeAddCustomProvider,
	OpencodeRemoveCustomProvider,
	SessionList,
	SessionStreamChanges,
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
	ChatArchivePreview,
	ChatCreate,
	ChatCreationList,
	ChatCreationStream,
	ChatCreationDiscard,
	ChatRename,
	ChatMarkRead,
	ChatStreamChanges,
	ChatSetWorktree,
	ChatSetActiveSession,
	ChatArchive,
	ChatArchiveStatus,
	ChatArchiveJobs,
	ChatDirectoryStatus,
	ChatUnarchive,
	ChatDelete,
	SessionResume,
	SessionFork,
	SessionExportTranscript,
	SessionLatestPlan,
	SessionSetRuntimeMode,
	SessionSetPermissionMode,
	SessionAnswerQuestion,
	SessionPlanRespond,
	SessionMcpUpdate,
	SessionSetWorktree,
	SessionEvents,
	SessionEventsHead,
	SessionGoalGet,
	SessionGoalSet,
	SessionGoalClear,
	SessionGoalStream,
	MessagesList,
	MessagesSend,
	MessagesInterrupt,
	MessagesQueueList,
	MessagesQueueAdd,
	MessagesQueueUpdate,
	MessagesQueueDelete,
	MessagesQueueRunNext,
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
);
