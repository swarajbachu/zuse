import { loadKiroInventory } from "@zuse/agents/drivers/kiro-inventory";
import {
	loadOpencodeInventory,
	removeOpencodeProviderAuth,
	setOpencodeProviderAuth,
} from "@zuse/agents/drivers/opencode";
import { safeModelId } from "@zuse/analytics";
import {
	AgentSessionStartError,
	AgentTurnId,
	ChatArchiveWorktreeError,
	ChatCreationConflictError,
	type ChatCreationOperation,
	ChatId,
	type ChatWorkspacePolicy,
	ComposerInput,
	CredentialStoreError,
	FolderId,
	MemoizeRpcs,
	MessageId,
	type ProviderId,
	SessionAlreadyStartedError,
	SessionId,
	SessionNotFoundError,
	SessionStartError,
	type SessionSummaryChange,
	type SessionTimelineFrame,
	WorktreeId,
} from "@zuse/contracts";
import { composerInputStartsDirectTurn } from "@zuse/domain/conversation/startup-input";
import { SessionDomain } from "@zuse/domain/engine/session-domain";
import { SqlSessionQueries } from "@zuse/domain/queries/sql-session-queries";
import { GitService } from "@zuse/git/git-service";
import { WorktreeService } from "@zuse/git/worktree-service";
import { KeyedEffectSerialWorker } from "@zuse/utils/keyed-worker";
import { Effect, Layer, Result, Schedule, Stream } from "effect";
import type { ChildProcessSpawner as CommandExecutor } from "effect/unstable/process";
import { SqlClient } from "effect/unstable/sql";
import { AnalyticsService } from "../analytics/services/analytics-service.ts";
import { ConfigStoreService } from "../config-store/services/config-store-service.ts";
import {
	decodeChatStartupIntent,
	persistChatStartupIntent,
	updateQueuedMessageWithStartupHandoff,
} from "../conversation/core/chat-startup-intent.ts";
import { resolveChatWorkspacePolicyRequest } from "../conversation/core/chat-workspace-policy.ts";
import { messageFromRecord } from "../conversation/core/conversation-records.ts";
import { timelineEventFromDomain } from "../conversation/core/conversation-timeline-projection.ts";
import { handoffToServiceScope } from "../conversation/core/service-scope.ts";
import {
	ChatService,
	MessageService,
	QueueService,
	QueueTransactionService,
	SessionService,
	TranscriptService,
} from "../conversation/services/conversation-services.ts";
import { RepositorySettingsService } from "../repository-settings/services/repository-settings-service.ts";
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

const requireKiroPath = (): Effect.Effect<
	string,
	AgentSessionStartError,
	CommandExecutor.ChildProcessSpawner
> =>
	Effect.gen(function* () {
		const kiroPath = yield* resolveCliPath("kiro-cli");
		if (kiroPath === null) {
			return yield* Effect.fail(
				new AgentSessionStartError({
					providerId: "kiro",
					reason:
						"Kiro CLI not found on PATH. Install from https://kiro.dev and ensure `kiro-cli` is available.",
				}),
			);
		}
		return kiroPath;
	});

// Renderer refreshes the Kiro model picker from the account's live catalog
// (control-plane ListAvailableModels, with CLI list-models fallback).
const KiroInventory = MemoizeRpcs.toLayerHandler(
	"provider.kiro.inventory",
	() =>
		Effect.gen(function* () {
			const kiroPath = yield* requireKiroPath();
			return yield* loadKiroInventory(kiroPath).pipe(
				Effect.mapError(
					(cause) =>
						new AgentSessionStartError({
							providerId: "kiro",
							reason: cause instanceof Error ? cause.message : String(cause),
						}),
				),
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
	readonly startup_ready: number;
	readonly workspace_policy: ChatCreationOperation["workspacePolicy"]["_tag"];
	readonly worktree_id: string | null;
	readonly phase: ChatCreationOperation["phase"];
	readonly failure_stage: ChatCreationOperation["failureStage"];
	readonly retryable: number;
	readonly workspace_attempt: number;
	readonly setup_attempt: number;
	readonly provider_attempt: number;
	readonly setup_bypassed: number;
	readonly lease_epoch: number;
	readonly fingerprint_version: number;
	readonly request_fingerprint: string | null;
	readonly phase_started_at: string;
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
	startupReady: row.startup_ready !== 0,
	workspacePolicy:
		row.workspace_policy === "fresh"
			? { _tag: "fresh" }
			: row.workspace_policy === "existing" && row.worktree_id !== null
				? { _tag: "existing", worktreeId: WorktreeId.make(row.worktree_id) }
				: { _tag: "main" },
	worktreeId:
		row.worktree_id === null ? null : WorktreeId.make(row.worktree_id),
	phase: row.phase,
	failureStage: row.failure_stage,
	retryable: row.retryable !== 0,
	attempts: {
		workspace: row.workspace_attempt,
		setup: row.setup_attempt,
		provider: row.provider_attempt,
	},
	setupBypassed: row.setup_bypassed !== 0,
	leaseEpoch: row.lease_epoch,
	fingerprintVersion: row.fingerprint_version,
	phaseStartedAt: new Date(row.phase_started_at),
	error: row.error,
	createdAt: new Date(row.created_at),
	updatedAt: new Date(row.updated_at),
});

const listChatCreationOperations = (projectId: string) =>
	Effect.flatMap(SqlClient.SqlClient, (sql) =>
		sql<ChatCreationOperationRow>`
			SELECT operation_id, chat_id, initial_session_id, project_id,
			       provider_id, model, title, runtime_mode, permission_mode,
			       tool_search, prompt, startup_input_json, startup_queue_id, startup_ready,
			       workspace_policy, worktree_id,
			       phase, failure_stage, retryable,
			       workspace_attempt, setup_attempt, provider_attempt,
			       setup_bypassed, lease_epoch, fingerprint_version,
			       request_fingerprint, phase_started_at,
			       error, created_at, updated_at
			FROM chat_creation_operations
			WHERE project_id = ${projectId}
			  AND (
			    phase NOT IN ('running', 'cancelled')
			    OR updated_at >= strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-10 minutes')
			  )
			ORDER BY created_at ASC
		`.pipe(
			Effect.orDie,
			Effect.map((rows) => rows.map(chatCreationOperationFromRow)),
		),
	);

const getChatCreationOperation = (operationId: string) =>
	Effect.flatMap(SqlClient.SqlClient, (sql) =>
		sql<ChatCreationOperationRow>`
			SELECT operation_id, chat_id, initial_session_id, project_id,
			       provider_id, model, title, runtime_mode, permission_mode,
			       tool_search, prompt, startup_input_json, startup_queue_id, startup_ready,
			       workspace_policy, worktree_id,
			       phase, failure_stage, retryable,
			       workspace_attempt, setup_attempt, provider_attempt,
			       setup_bypassed, lease_epoch, fingerprint_version,
			       request_fingerprint, phase_started_at,
			       error, created_at, updated_at
			FROM chat_creation_operations
			WHERE operation_id = ${operationId}
			LIMIT 1
		`.pipe(
			Effect.orDie,
			Effect.map((rows) => {
				const row = rows[0];
				return row === undefined ? null : chatCreationOperationFromRow(row);
			}),
		),
	);

const canonicalJson = (value: unknown): string => {
	if (value === null || typeof value !== "object") return JSON.stringify(value);
	if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
	return `{${Object.entries(value as Readonly<Record<string, unknown>>)
		.sort(([left], [right]) => left.localeCompare(right))
		.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
		.join(",")}}`;
};

const sha256 = (value: string): Effect.Effect<string> =>
	Effect.promise(async () => {
		const bytes = await crypto.subtle.digest(
			"SHA-256",
			new TextEncoder().encode(value),
		);
		return Array.from(new Uint8Array(bytes), (byte) =>
			byte.toString(16).padStart(2, "0"),
		).join("");
	});

const creationPhaseStatus = (
	phase: ChatCreationOperation["phase"],
):
	| "pending"
	| "creating_workspace"
	| "creating_chat"
	| "succeeded"
	| "failed" => {
	switch (phase) {
		case "persisted":
		case "cancelling":
		case "cancelled":
			return "pending";
		case "creating_workspace":
		case "running_setup":
			return "creating_workspace";
		case "starting_agent":
			return "creating_chat";
		case "running":
			return "succeeded";
		case "failed":
			return "failed";
	}
};

const updateCreationPhase = (
	sql: SqlClient.SqlClient,
	operationId: string,
	phase: ChatCreationOperation["phase"],
	options?: {
		readonly failureStage?: ChatCreationOperation["failureStage"];
		readonly retryable?: boolean;
		readonly error?: string | null;
	},
) => {
	const now = new Date().toISOString();
	return sql`
		UPDATE chat_creation_operations
		SET phase = ${phase}, status = ${creationPhaseStatus(phase)},
		    failure_stage = ${options?.failureStage ?? null},
		    retryable = ${options?.retryable === false ? 0 : 1},
		    error = ${options?.error ?? null}, phase_started_at = ${now},
		    updated_at = ${now}
		WHERE operation_id = ${operationId}
	`.pipe(Effect.asVoid, Effect.orDie);
};

const ChatCreate = MemoizeRpcs.toLayerHandler(
	"chat.create",
	Effect.gen(function* () {
		const serviceScope = yield* Effect.scope;
		return (input) =>
			handoffToServiceScope(
				Effect.void,
				chatCreationWorker.run(
					input.operationId ?? input.chatId ?? crypto.randomUUID(),
					Effect.gen(function* () {
						const creationStartedAt = Date.now();
						const svc = yield* ChatService;
						const queueTransaction = yield* QueueTransactionService;
						const analytics = yield* AnalyticsService;
						const sql = yield* SqlClient.SqlClient;
						let resolvedWorkspacePolicy: ChatWorkspacePolicy;
						if (input.workspacePolicy?._tag === "automatic") {
							const configStore = yield* ConfigStoreService;
							const repositorySettings = yield* RepositorySettingsService;
							const globalSettings = yield* configStore.getSettings();
							const repository = yield* repositorySettings.get(input.projectId);
							resolvedWorkspacePolicy = resolveChatWorkspacePolicyRequest({
								request: input.workspacePolicy,
								legacyWorktreeId: input.worktreeId,
								defaultAutoCreateWorktree:
									globalSettings.defaultAutoCreateWorktree,
								repositoryAutoCreateWorktree: repository.autoCreateWorktree,
							});
						} else {
							resolvedWorkspacePolicy = resolveChatWorkspacePolicyRequest({
								request: input.workspacePolicy,
								legacyWorktreeId: input.worktreeId,
								defaultAutoCreateWorktree: false,
								repositoryAutoCreateWorktree: false,
							});
						}
						// The renderer has already placed this request in its durable outbox.
						// Resolve settings here so reconnects never strand an optimistic session
						// before chat.create is dispatchable; Git work stays in the worker below.
						const policy = resolvedWorkspacePolicy._tag;
						const requestFingerprint =
							input.operationId === undefined
								? null
								: yield* sha256(
										canonicalJson({
											version: 1,
											operationId: input.operationId,
											chatId: input.chatId ?? null,
											initialSessionId: input.initialSessionId ?? null,
											projectId: input.projectId,
											providerId: input.providerId,
											model: input.model,
											title: input.title ?? null,
											runtimeMode: input.runtimeMode ?? "approval-required",
											permissionMode: input.permissionMode ?? "default",
											toolSearch: input.toolSearch === true,
											workspacePolicy: input.workspacePolicy ?? null,
											worktreeId: input.worktreeId ?? null,
											initialPrompt: input.initialPrompt ?? null,
											startupInput: input.startupInput ?? null,
										}),
									);
						if (
							input.operationId !== undefined &&
							input.chatId !== undefined &&
							input.initialSessionId !== undefined
						) {
							const now = new Date().toISOString();
							const requestedWorktreeId =
								policy === "fresh"
									? WorktreeId.make(crypto.randomUUID())
									: policy === "existing"
										? resolvedWorkspacePolicy._tag === "existing"
											? resolvedWorkspacePolicy.worktreeId
											: null
										: null;
							yield* sql`
				INSERT INTO chat_creation_operations (
					operation_id, chat_id, initial_session_id, project_id,
					provider_id, model, title, runtime_mode, permission_mode,
					tool_search, prompt, startup_input_json, startup_queue_id, startup_ready,
					workspace_policy, worktree_id,
					status, phase, fingerprint_version, request_fingerprint,
					phase_started_at, error, created_at, updated_at
				) VALUES (
					${input.operationId}, ${input.chatId}, ${input.initialSessionId},
					${input.projectId}, ${input.providerId}, ${input.model},
					${input.title ?? null}, ${input.runtimeMode ?? "approval-required"},
					${input.permissionMode ?? "default"}, ${input.toolSearch === true ? 1 : 0},
					${input.startupInput?.text ?? null},
					${input.startupInput === undefined ? null : JSON.stringify(input.startupInput)},
					${input.startupQueueId ?? null},
					${input.startupReady === false ? 0 : 1},
					${policy}, ${requestedWorktreeId},
					'pending', 'persisted', 1, ${requestFingerprint},
					${now}, NULL, ${now}, ${now}
				)
				ON CONFLICT(operation_id) DO NOTHING
			`.pipe(Effect.orDie);
						}
						const operationRows =
							input.operationId === undefined
								? []
								: yield* sql<{
										readonly chat_id: string;
										readonly initial_session_id: string;
										readonly startup_input_json: string | null;
										readonly startup_queue_id: string | null;
										readonly startup_ready: number;
										readonly workspace_policy: ChatCreationOperation["workspacePolicy"]["_tag"];
										readonly worktree_id: string | null;
										readonly status:
											| "pending"
											| "creating_workspace"
											| "creating_chat"
											| "succeeded"
											| "failed";
										readonly phase: ChatCreationOperation["phase"];
										readonly request_fingerprint: string | null;
										readonly setup_bypassed: number;
									}>`
						SELECT chat_id, initial_session_id, startup_input_json,
						       startup_queue_id, startup_ready, workspace_policy, worktree_id,
						       status, phase, request_fingerprint
						       , setup_bypassed
						FROM chat_creation_operations
						WHERE operation_id = ${input.operationId}
						LIMIT 1
					`.pipe(Effect.orDie);
						const durableOperation = operationRows[0];
						const durablePolicy = durableOperation?.workspace_policy ?? policy;
						const durableWorktreeId = durableOperation?.worktree_id ?? null;
						if (
							requestFingerprint !== null &&
							durableOperation?.request_fingerprint !== null &&
							durableOperation?.request_fingerprint !== requestFingerprint
						) {
							return yield* new ChatCreationConflictError({
								operationId: input.operationId ?? "legacy",
								reason:
									"The operation id is already bound to different chat creation input.",
							});
						}
						if (
							input.operationId !== undefined &&
							input.chatId !== undefined &&
							input.initialSessionId !== undefined &&
							durableOperation !== undefined
						) {
							const operationId = input.operationId;
							const sessionId = SessionId.make(
								durableOperation.initial_session_id,
							);
							const chatId = ChatId.make(durableOperation.chat_id);
							const requestedId =
								durablePolicy === "main"
									? null
									: WorktreeId.make(durableWorktreeId ?? crypto.randomUUID());
							const storedInput =
								durableOperation.startup_input_json === null
									? input.initialPrompt === undefined
										? undefined
										: ComposerInput.make({
												text: input.initialPrompt,
												attachments: [],
												fileRefs: [],
												skillRefs: [],
												annotations: [],
											})
									: ComposerInput.make(
											JSON.parse(durableOperation.startup_input_json),
										);
							const useDirectTurn =
								durableOperation.startup_ready !== 0 &&
								storedInput !== undefined &&
								composerInputStartsDirectTurn(storedInput);
							const initialPrompt = useDirectTurn
								? storedInput?.text.trim()
								: input.initialPrompt;
							const result = yield* svc.createChat({
								chatId,
								initialSessionId: sessionId,
								commandId: `chat-create:${operationId}:bootstrap`,
								initialTurnId:
									initialPrompt === undefined
										? undefined
										: AgentTurnId.make(`turn_${operationId}`),
								initialMessageId:
									initialPrompt === undefined
										? undefined
										: MessageId.make(`message_${operationId}`),
								projectId: input.projectId,
								providerId: input.providerId,
								model: input.model,
								title: input.title,
								initialPrompt,
								runtimeMode: input.runtimeMode,
								worktreeId: null,
								agents: input.agents,
								enableSubagents: input.enableSubagents,
								permissionMode: input.permissionMode,
								modelOptions: input.modelOptions,
								toolSearch: input.toolSearch,
								originSessionId: input.originSessionId ?? null,
								background: true,
								queuePaused: true,
							});
							const lifecycle = chatCreationWorker.run(
								operationId,
								Effect.gen(function* () {
									const worktrees = yield* WorktreeService;
									const queue = yield* QueueService;
									const sessions = yield* SessionService;
									const sessionDomain = yield* SessionDomain;
									const lifecycleOperation =
										yield* getChatCreationOperation(operationId);
									// Replayed create commands acknowledge the already-durable entities.
									// Recovery is explicit, so a duplicate must never regress a terminal
									// phase or repeat an external side effect after a recorded failure.
									if (
										lifecycleOperation === null ||
										lifecycleOperation.phase === "running" ||
										lifecycleOperation.phase === "failed" ||
										lifecycleOperation.phase === "cancelling" ||
										lifecycleOperation.phase === "cancelled"
									) {
										return;
									}
									const cancellationRequested = sql<{
										readonly phase: ChatCreationOperation["phase"];
									}>`
										SELECT phase FROM chat_creation_operations
										WHERE operation_id = ${operationId} LIMIT 1
									`.pipe(
										Effect.orDie,
										Effect.map(
											(rows) =>
												rows[0]?.phase === "cancelling" ||
												rows[0]?.phase === "cancelled",
										),
									);
									let worktree =
										requestedId === null
											? null
											: yield* worktrees.get(requestedId);
									if (durablePolicy === "fresh" && worktree === null) {
										yield* sql`
											UPDATE chat_creation_operations
											SET phase = 'creating_workspace', status = 'creating_workspace',
											    workspace_attempt = workspace_attempt + 1,
											    failure_stage = NULL, error = NULL,
											    phase_started_at = ${new Date().toISOString()},
											    updated_at = ${new Date().toISOString()}
											WHERE operation_id = ${operationId}
										`.pipe(Effect.orDie);
										const isRepository = yield* Effect.flatMap(
											GitService,
											(git) => git.isRepository(input.projectId),
										).pipe(Effect.orElseSucceed(() => false));
										if (!isRepository) {
											yield* updateCreationPhase(sql, operationId, "failed", {
												failureStage: "configuration",
												retryable: false,
												error: "This project is not a Git repository.",
											});
											return;
										}
										if (requestedId === null) {
											return yield* Effect.die(
												"fresh workspace lifecycle lost its reserved identity",
											);
										}
										const created = yield* worktrees
											.create(input.projectId, undefined, requestedId)
											.pipe(Effect.result);
										if (created._tag === "Failure") {
											yield* updateCreationPhase(sql, operationId, "failed", {
												failureStage: "workspace",
												error: created.failure.reason,
											});
											return;
										}
										worktree = created.success;
									}
									if (yield* cancellationRequested) return;
									if (durablePolicy === "existing" && worktree === null) {
										yield* updateCreationPhase(sql, operationId, "failed", {
											failureStage: "configuration",
											retryable: false,
											error: "The selected workspace no longer exists.",
										});
										return;
									}
									if (worktree !== null) {
										yield* svc
											.setChatWorktree(chatId, worktree.id, true)
											.pipe(Effect.orDie);
									}
									if (
										worktree !== null &&
										durableOperation.setup_bypassed === 0 &&
										worktree.setupStatus !== "succeeded" &&
										worktree.setupStatus !== "skipped"
									) {
										yield* updateCreationPhase(
											sql,
											operationId,
											"running_setup",
										);
										yield* worktrees.setupStream(worktree.id).pipe(
											Stream.runDrain,
											Effect.catch(() => Effect.void),
										);
									}
									const ready =
										worktree === null
											? null
											: yield* worktrees.get(worktree.id);
									if (
										worktree !== null &&
										durableOperation.setup_bypassed === 0 &&
										(ready === null || ready.setupStatus === "failed")
									) {
										yield* updateCreationPhase(sql, operationId, "failed", {
											failureStage: "setup",
											error:
												ready?.setupOutput.trim() ||
												"The workspace setup failed.",
										});
										return;
									}
									if (yield* cancellationRequested) return;
									yield* updateCreationPhase(
										sql,
										operationId,
										"starting_agent",
									);
									const pauseRows = yield* sql<{
										readonly queue_paused: number;
									}>`
										SELECT queue_paused FROM sessions WHERE id = ${sessionId} LIMIT 1
									`.pipe(Effect.orDie);
									const needsRelease = pauseRows[0]?.queue_paused === 1;
									if (
										needsRelease &&
										useDirectTurn &&
										storedInput !== undefined
									) {
										yield* sessions.releaseInitialTurn(
											`chat-create:${operationId}:release`,
											sessionId,
											AgentTurnId.make(`turn_${operationId}`),
											JSON.stringify(storedInput),
										);
									} else if (needsRelease) {
										const startupIntent = decodeChatStartupIntent({
											operationId,
											initialSessionId: sessionId,
											startupInput: storedInput,
											startupQueueId:
												durableOperation.startup_queue_id ?? undefined,
											startupReady: durableOperation.startup_ready !== 0,
										});
										if (startupIntent !== null) {
											yield* persistChatStartupIntent(
												queueTransaction,
												sql,
												startupIntent,
											).pipe(Effect.orDie);
											yield* queue
												.resumeQueuedMessages(
													`chat-create:${operationId}:resume`,
													sessionId,
												)
												.pipe(Effect.orDie);
										} else {
											yield* sessionDomain
												.dispatch({
													commandId: `chat-create:${operationId}:unpause`,
													streamId: sessionId,
													command: {
														_tag: "SetQueuePaused",
														paused: false,
														updatedAt: Date.now(),
													},
												})
												.pipe(Effect.orDie);
										}
									}
									for (let attempt = 0; attempt < 240; attempt += 1) {
										if (attempt % 4 === 0 && (yield* cancellationRequested))
											return;
										const session = yield* sessions
											.getSession(sessionId)
											.pipe(Effect.catch(() => Effect.succeed(null)));
										if (session?.status === "error") {
											yield* sql`
												UPDATE chat_creation_operations
												SET provider_attempt = provider_attempt + 1
												WHERE operation_id = ${operationId}
											`.pipe(Effect.orDie);
											yield* updateCreationPhase(sql, operationId, "failed", {
												failureStage: "provider",
												error: "The agent could not be started.",
											});
											return;
										}
										if (
											session?.status === "running" ||
											session?.status === "idle"
										) {
											yield* updateCreationPhase(sql, operationId, "running");
											return;
										}
										yield* Effect.sleep("250 millis");
									}
									yield* updateCreationPhase(sql, operationId, "failed", {
										failureStage: "provider",
										error:
											"The agent did not accept the durable turn within 60 seconds.",
									});
								}).pipe(
									Effect.catchCause((cause) =>
										Effect.gen(function* () {
											const current =
												yield* getChatCreationOperation(operationId);
											if (
												current === null ||
												current.phase === "failed" ||
												current.phase === "running" ||
												current.phase === "cancelling" ||
												current.phase === "cancelled"
											) {
												return;
											}
											const failureStage =
												current.phase === "creating_workspace"
													? "workspace"
													: current.phase === "running_setup"
														? "setup"
														: "provider";
											yield* updateCreationPhase(sql, operationId, "failed", {
												failureStage,
												error: `Startup interrupted: ${String(cause)}`,
											});
										}),
									),
								),
							);
							yield* Effect.forkIn(lifecycle, serviceScope, {
								startImmediately: true,
							});
							yield* analytics.capture("chat created", {
								provider: input.providerId,
								model: safeModelId(input.providerId, input.model),
								runtime_mode: input.runtimeMode ?? "unknown",
							});
							yield* Effect.logInfo(
								`[chat-creation-timing] operation=${operationId} durable_chat_ack_ms=${Date.now() - creationStartedAt}`,
							);
							return result;
						}
						if (
							input.operationId !== undefined &&
							durablePolicy === "main" &&
							durableOperation?.status !== "succeeded"
						) {
							yield* sql`
					UPDATE chat_creation_operations
					SET workspace_policy = 'main', worktree_id = NULL,
					    updated_at = ${new Date().toISOString()}
					WHERE operation_id = ${input.operationId} AND status <> 'succeeded'
				`.pipe(Effect.orDie);
						}
						const worktreeId =
							durablePolicy === "fresh"
								? durableOperation?.status === "succeeded" &&
									durableWorktreeId !== null
									? WorktreeId.make(durableWorktreeId)
									: yield* Effect.gen(function* () {
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
													worktrees.create(
														input.projectId,
														undefined,
														requestedId,
													),
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
									SET worktree_id = ${created.id}, updated_at = ${new Date().toISOString()}
									WHERE operation_id = ${input.operationId}
								`.pipe(Effect.orDie);
											}
											// A directory existing is not the same thing as an execution
											// workspace being ready. The provider, startup queue, file tree,
											// and terminal must all cross the same setup terminal edge.
											const worktrees = yield* WorktreeService;
											yield* worktrees.setupStream(created.id).pipe(
												Stream.runDrain,
												Effect.mapError(
													(error) =>
														new SessionStartError({
															providerId: input.providerId,
															reason: `The fresh worktree setup could not be observed: ${String(error)}`,
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
											const ready = yield* worktrees.get(created.id);
											if (ready === null || ready.setupStatus === "failed") {
												const error = new SessionStartError({
													providerId: input.providerId,
													reason:
														ready?.setupOutput.trim() ||
														"The fresh worktree setup failed.",
												});
												if (input.operationId !== undefined) {
													yield* sql`
											UPDATE chat_creation_operations
											SET status = 'failed', error = ${error.reason},
											    updated_at = ${new Date().toISOString()}
											WHERE operation_id = ${input.operationId}
										`.pipe(Effect.orDie);
												}
												return yield* error;
											}
											if (input.operationId !== undefined) {
												yield* sql`
									UPDATE chat_creation_operations
									SET status = 'creating_chat', updated_at = ${new Date().toISOString()}
									WHERE operation_id = ${input.operationId}
								`.pipe(Effect.orDie);
											}
											return created.id;
										})
								: durablePolicy === "existing"
									? durableWorktreeId !== null
										? WorktreeId.make(durableWorktreeId)
										: input.workspacePolicy?._tag === "existing"
											? input.workspacePolicy.worktreeId
											: (input.worktreeId ?? null)
									: durablePolicy === "main"
										? null
										: (input.worktreeId ?? null);
						if (
							input.operationId !== undefined &&
							durablePolicy !== "fresh" &&
							durableOperation?.status !== "succeeded"
						) {
							yield* sql`
					UPDATE chat_creation_operations
					SET worktree_id = ${worktreeId}, status = 'creating_chat',
					    updated_at = ${new Date().toISOString()}
					WHERE operation_id = ${input.operationId} AND status <> 'succeeded'
				`.pipe(Effect.orDie);
						}
						const result = yield* svc
							.createChat({
								chatId:
									durableOperation === undefined
										? input.chatId
										: ChatId.make(durableOperation.chat_id),
								initialSessionId:
									durableOperation === undefined
										? input.initialSessionId
										: SessionId.make(durableOperation.initial_session_id),
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
							);
						const startupIntent =
							durableOperation === undefined
								? decodeChatStartupIntent(input)
								: decodeChatStartupIntent({
										operationId: input.operationId,
										initialSessionId: SessionId.make(
											durableOperation.initial_session_id,
										),
										startupInput:
											durableOperation.startup_input_json === null
												? undefined
												: ComposerInput.make(
														JSON.parse(durableOperation.startup_input_json),
													),
										startupQueueId:
											durableOperation.startup_queue_id ?? undefined,
										startupReady: durableOperation.startup_ready !== 0,
									});
						if (startupIntent !== null) {
							yield* persistChatStartupIntent(
								queueTransaction,
								sql,
								startupIntent,
							).pipe(
								Effect.mapError(
									(error) =>
										new SessionStartError({
											providerId: input.providerId,
											reason: `Could not persist the startup prompt: ${String(error)}`,
										}),
								),
								Effect.tapError((error) =>
									sql`
							UPDATE chat_creation_operations
							SET status = 'failed', error = ${error.reason},
							    updated_at = ${new Date().toISOString()}
							WHERE operation_id = ${startupIntent.operationId}
						`.pipe(Effect.orDie),
								),
							);
						}
						if (input.operationId !== undefined && startupIntent === null) {
							yield* sql`
					UPDATE chat_creation_operations
					SET status = 'succeeded', error = NULL,
					    updated_at = ${new Date().toISOString()}
					WHERE operation_id = ${input.operationId}
				`.pipe(Effect.orDie);
						}
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
				serviceScope,
			);
	}),
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
							operation.phase === candidate.phase &&
							operation.failureStage === candidate.failureStage &&
							operation.attempts.workspace === candidate.attempts.workspace &&
							operation.attempts.setup === candidate.attempts.setup &&
							operation.attempts.provider === candidate.attempts.provider &&
							operation.setupBypassed === candidate.setupBypassed &&
							operation.worktreeId === candidate.worktreeId &&
							operation.error === candidate.error &&
							operation.updatedAt.getTime() === candidate.updatedAt.getTime()
						);
					}),
			),
			Stream.map((operations) => ({
				_tag: "snapshot" as const,
				operations,
			})),
		),
);

const ChatCreationRecover = MemoizeRpcs.toLayerHandler(
	"chat.creation.recover",
	({
		operationId,
		action,
		expectedPhase,
		expectedFailureStage,
		expectedAttempt,
	}) =>
		Effect.gen(function* () {
			const sql = yield* SqlClient.SqlClient;
			const operation = yield* getChatCreationOperation(operationId);
			if (operation === null) return yield* Effect.die("creation not found");
			const currentAttempt =
				expectedFailureStage === "workspace"
					? operation.attempts.workspace
					: expectedFailureStage === "setup"
						? operation.attempts.setup
						: operation.attempts.provider;
			if (
				operation.phase !== expectedPhase ||
				operation.failureStage !== expectedFailureStage ||
				currentAttempt !== expectedAttempt ||
				operation.phase !== "failed"
			) {
				return operation;
			}
			const legal =
				(action === "retry_workspace" &&
					operation.failureStage === "workspace") ||
				((action === "retry_setup" || action === "continue_anyway") &&
					operation.failureStage === "setup") ||
				(action === "retry_agent" && operation.failureStage === "provider");
			if (!legal || !operation.retryable) return operation;
			const nextPhase =
				action === "retry_workspace"
					? "persisted"
					: action === "retry_setup"
						? "running_setup"
						: "starting_agent";
			const updatedAt = new Date().toISOString();
			const updated = yield* sql<{ readonly operation_id: string }>`
				UPDATE chat_creation_operations
				SET phase = ${nextPhase}, status = ${creationPhaseStatus(nextPhase)},
				    failure_stage = NULL, error = NULL,
				    workspace_attempt = workspace_attempt + ${action === "retry_workspace" ? 1 : 0},
				    setup_attempt = setup_attempt + ${action === "retry_setup" ? 1 : 0},
				    provider_attempt = provider_attempt + ${action === "retry_agent" ? 1 : 0},
				    setup_bypassed = ${action === "continue_anyway" ? 1 : operation.setupBypassed ? 1 : 0},
				    lease_epoch = lease_epoch + 1,
				    phase_started_at = ${updatedAt}, updated_at = ${updatedAt}
				WHERE operation_id = ${operationId}
				  AND phase = ${expectedPhase}
				  AND COALESCE(failure_stage, '') = ${expectedFailureStage ?? ""}
				  AND lease_epoch = ${operation.leaseEpoch}
				RETURNING operation_id
			`.pipe(Effect.orDie);
			if (updated.length === 0) {
				return (yield* getChatCreationOperation(operationId)) ?? operation;
			}
			if (action === "retry_setup" && operation.worktreeId !== null) {
				const worktrees = yield* WorktreeService;
				const rerun = yield* worktrees
					.rerunSetup(operation.worktreeId)
					.pipe(Effect.result);
				if (rerun._tag === "Failure") {
					yield* updateCreationPhase(sql, operationId, "failed", {
						failureStage: "setup",
						error:
							"reason" in rerun.failure
								? rerun.failure.reason
								: String(rerun.failure),
					});
				}
			}
			if (action === "retry_agent") {
				yield* Effect.flatMap(SessionService, (sessions) =>
					sessions.resumeSession(operation.initialSessionId),
				).pipe(Effect.catch(() => Effect.void));
			}
			return (yield* getChatCreationOperation(operationId)) ?? operation;
		}),
);

const ChatCreationDiscard = MemoizeRpcs.toLayerHandler(
	"chat.creation.discard",
	({ operationId }) =>
		Effect.gen(function* () {
			const sql = yield* SqlClient.SqlClient;
			const rows = yield* sql<{
				readonly operation_id: string;
				readonly chat_id: string;
			}>`
				SELECT operation_id, chat_id FROM chat_creation_operations
				WHERE operation_id = ${operationId} AND phase NOT IN ('running', 'cancelled')
				LIMIT 1
			`.pipe(Effect.orDie);
			if (rows.length === 0) return { discarded: false };
			yield* updateCreationPhase(sql, operationId, "cancelling");
			const chatId = ChatId.make(rows[0]?.chat_id ?? "");
			return yield* chatCreationWorker.run(
				operationId,
				Effect.gen(function* () {
					yield* Effect.flatMap(ChatService, (chats) =>
						chats.deleteChat(chatId),
					).pipe(Effect.catch(() => Effect.void));
					yield* sql`
						UPDATE chat_creation_operations
						SET phase = 'cancelled', status = 'pending', error = NULL,
						    updated_at = ${new Date().toISOString()}
						WHERE operation_id = ${operationId} AND phase = 'cancelling'
					`.pipe(Effect.orDie);
					return { discarded: true };
				}),
			);
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
			const result = yield* svc.archiveChat(chatId, force ?? false).pipe(
				Effect.catchTags({
					ChatArchiveScriptError: (error) =>
						Effect.fail(
							new ChatArchiveWorktreeError({
								chatId,
								reason: error.output || "Archive cleanup script failed.",
							}),
						),
					ChatArchiveTimeoutError: (error) =>
						Effect.fail(
							new ChatArchiveWorktreeError({
								chatId,
								reason: error.output || "Archive cleanup script timed out.",
							}),
						),
				}),
			);
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
	({ commandId, sessionId, title }) =>
		Effect.flatMap(SessionService, (svc) =>
			svc.renameSession(sessionId, title, commandId),
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
	({ commandId, sessionId, runtimeMode }) =>
		Effect.flatMap(SessionService, (svc) =>
			svc.setRuntimeMode(sessionId, runtimeMode, commandId),
		),
);

const SessionSetPermissionMode = MemoizeRpcs.toLayerHandler(
	"session.setPermissionMode",
	({ commandId, sessionId, mode }) =>
		Effect.flatMap(SessionService, (svc) =>
			svc.setPermissionMode(sessionId, mode, commandId),
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
	({ sessionId, afterVersion, streamEpoch, hasProjection }) =>
		Stream.unwrap(
			Effect.gen(function* () {
				const sessions = yield* SessionService;
				yield* sessions.getSession(sessionId);
				const domain = yield* SessionDomain;
				return domain
					.synchronizedEvents({
						streamId: sessionId,
						afterVersion,
						streamEpoch,
						hasProjection,
					})
					.pipe(
						Stream.map((frame): SessionTimelineFrame => {
							if (frame.kind === "reset-required") {
								return {
									kind: "reset-required",
									sessionId,
									throughVersion: frame.throughVersion,
									cursor: {
										epoch: frame.streamEpoch,
										version: frame.throughVersion,
									},
									reason: frame.reason,
								};
							}
							if (frame.kind === "snapshot") {
								return {
									kind: "snapshot",
									sessionId,
									throughVersion: frame.throughVersion,
									projection: frame.projection,
									cursor: {
										epoch: frame.streamEpoch,
										version: frame.throughVersion,
									},
									olderMessageSequence: frame.olderMessageSequence,
									totalMessageCount: frame.totalMessageCount,
								};
							}
							if (frame.kind === "snapshot-chunk") {
								return {
									kind: "snapshot-chunk",
									sessionId,
									throughVersion: frame.throughVersion,
									messages: frame.messages,
									olderMessageSequence: frame.olderMessageSequence,
									cursor: {
										epoch: frame.streamEpoch,
										version: frame.throughVersion,
									},
								};
							}
							if (frame.kind === "synchronized") {
								return {
									kind: "synchronized",
									sessionId,
									throughVersion: frame.throughVersion,
									cursor: {
										epoch: frame.streamEpoch,
										version: frame.throughVersion,
									},
								};
							}
							return {
								kind: "event",
								sessionId,
								streamVersion: frame.record.streamVersion,
								eventId: frame.record.eventId,
								event: timelineEventFromDomain(sessionId, frame.record.event),
								cursor: {
									epoch: frame.streamEpoch,
									version: frame.record.streamVersion,
								},
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
				streamEpoch: domain.streamEpoch,
			};
		}),
);

const SessionMessagesPage = MemoizeRpcs.toLayerHandler(
	"session.messages.page",
	({ sessionId, beforeSequence, limit }) =>
		Effect.gen(function* () {
			const queries = yield* SqlSessionQueries;
			const page = yield* queries
				.messagePage({
					sessionId,
					beforeSequence,
					limit: Math.max(1, Math.min(200, Math.trunc(limit ?? 100))),
				})
				.pipe(Effect.mapError(() => new SessionNotFoundError({ sessionId })));
			return {
				messages: page.items.map(messageFromRecord),
				olderMessageSequence: page.olderSequence,
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
	({ commandId, sessionId, text, input, asGoal, clientMessageId }) => {
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
				commandId,
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
	({ commandId, sessionId, expectedTurnId }) =>
		Effect.flatMap(MessageService, (svc) =>
			svc.interruptSession(commandId, sessionId, expectedTurnId),
		),
);

const MessagesQueueList = MemoizeRpcs.toLayerHandler(
	"messages.queue.list",
	({ sessionId }) =>
		Effect.flatMap(QueueService, (svc) => svc.listQueuedMessages(sessionId)),
);

const MessagesQueueAdd = MemoizeRpcs.toLayerHandler(
	"messages.queue.add",
	({ commandId, sessionId, queueId, input, ready, flush }) =>
		Effect.gen(function* () {
			const svc = yield* QueueService;
			const analytics = yield* AnalyticsService;
			const result = yield* svc.addQueuedMessage(
				commandId,
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
	({ commandId, sessionId, queueId, input }) =>
		Effect.gen(function* () {
			const queue = yield* QueueService;
			const queueTransaction = yield* QueueTransactionService;
			const sql = yield* SqlClient.SqlClient;
			return yield* updateQueuedMessageWithStartupHandoff(
				queue,
				queueTransaction,
				sql,
				commandId,
				sessionId,
				queueId,
				input,
			);
		}),
);

const MessagesQueueDelete = MemoizeRpcs.toLayerHandler(
	"messages.queue.delete",
	({ commandId, sessionId, queueId }) =>
		Effect.flatMap(QueueService, (svc) =>
			svc.deleteQueuedMessage(commandId, sessionId, queueId),
		),
);

const MessagesQueueRunNext = MemoizeRpcs.toLayerHandler(
	"messages.queue.runNext",
	({ commandId, sessionId, queueId }) =>
		Effect.flatMap(QueueService, (svc) =>
			svc.runQueuedMessageNext(commandId, sessionId, queueId),
		),
);

const MessagesQueueReorder = MemoizeRpcs.toLayerHandler(
	"messages.queue.reorder",
	({ commandId, sessionId, queueIds }) =>
		Effect.flatMap(QueueService, (svc) =>
			svc.reorderQueuedMessages(commandId, sessionId, queueIds),
		),
);

const MessagesQueueFlush = MemoizeRpcs.toLayerHandler(
	"messages.queue.flush",
	({ commandId, sessionId }) =>
		Effect.flatMap(QueueService, (svc) =>
			svc.flushQueuedMessages(commandId, sessionId),
		),
);

const MessagesQueueResume = MemoizeRpcs.toLayerHandler(
	"messages.queue.resume",
	({ commandId, sessionId }) =>
		Effect.flatMap(QueueService, (svc) =>
			svc.resumeQueuedMessages(commandId, sessionId),
		),
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
	KiroInventory,
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
	ChatCreationRecover,
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
	SessionMessagesPage,
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
