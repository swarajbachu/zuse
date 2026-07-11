import { isIgnorableGrokAuthNoise } from "@zuse/agents/drivers/acp/grok-auth-noise";
import { canonicalizeToolInput } from "@zuse/agents/kernel/tool-input";
import {
	type AgentDefinition,
	type AttachmentRef,
	type Chat,
	ChatAlreadyStartedError,
	type ChatArchiveResult,
	ChatArchiveScriptError,
	ChatArchiveWorktreeError,
	ChatId,
	ChatNotFoundError,
	type ComposerAnnotation,
	DEFAULT_PERMISSION_MODE,
	DEFAULT_RUNTIME_MODE,
	type FileRef,
	type FolderId,
	Message,
	type MessageContent,
	MessageId,
	type MessageOrigin,
	type ProviderId,
	type ResumeStrategy,
	Session,
	SessionAlreadyStartedError,
	SessionId,
	SessionNotFoundError,
	SessionStartError,
	type SkillRef,
	ThreadGoal,
	type Worktree,
	WorktreeId,
} from "@zuse/contracts";
import type { ChatCommand } from "@zuse/domain/chat/commands";
import type { SessionCommand } from "@zuse/domain/core/commands";
import { ChatDomain } from "@zuse/domain/engine/chat-domain";
import { SessionDomain } from "@zuse/domain/engine/session-domain";
import { SqlSessionQueries } from "@zuse/domain/queries/sql-session-queries";
import { GitService } from "@zuse/git/git-service";
import { WorktreeService } from "@zuse/git/worktree-service";
import {
	Context,
	DateTime,
	Effect,
	Layer,
	PubSub,
	Ref,
	Schema,
	Stream,
} from "effect";
import { SqlClient } from "effect/unstable/sql";
import { ConfigStoreService } from "../../config-store/services/config-store-service.ts";
import { NdjsonLogger } from "../../persistence/ndjson-logger.ts";
import { PtyService } from "../../pty/services/pty-service.ts";
import { RelayActivityPublisher } from "../../relay/activity-publisher.ts";
import { RepositorySettingsService } from "../../repository-settings/services/repository-settings-service.ts";
import { runArchiveScript } from "../conversation-archive-script.ts";
import { makeConversationEventRuntime } from "../conversation-event-runtime.ts";
import {
	isGoalCapableProvider,
	makeConversationGoalOperations,
} from "../conversation-goal-operations.ts";
import { makeConversationGoalState } from "../conversation-goal-state.ts";
import {
	deriveProvisionalTitle,
	formatProviderFailure,
	looksLikeAuthFailure,
	serializeAnnotations,
	textFromMessageContent,
} from "../conversation-input.ts";
import {
	parentItemIdOfContent,
	roleForContent,
	shouldIncludeInTranscript,
	transcriptToMarkdown,
} from "../conversation-message-mapping.ts";
import { makeConversationOrchestration } from "../conversation-orchestration.ts";
import {
	type ChatArchiveReactorError,
	type ConversationReactorHandlers,
	makeConversationReactorRuntime,
} from "../conversation-reactors.ts";
import {
	type ChatRow,
	chatFromRow,
	type MessageRow,
	messageFromRecord,
	messageFromRow,
	parseAgents,
	parseArchivedWorktreeSnapshot,
	type SessionRow,
	sessionFromRecord,
	sessionFromRow,
} from "../conversation-records.ts";
import { ConversationState } from "../conversation-state.ts";
import { makeReactorEffectJournal } from "../reactor-effect-journal.ts";
import {
	ChatService,
	type ChatServiceShape,
	type ConversationOperations,
	type CreateChatInput,
	type CreateSessionInput,
	MessageService,
	type MessageServiceShape,
	QueueService,
	SessionService,
	type SessionServiceShape,
	TranscriptService,
	type TranscriptServiceShape,
} from "../services/conversation-services.ts";
import { ProviderService } from "../services/provider-service.ts";
import {
	buildConversationText,
	formatBranchName,
	shouldDeferAutoName,
	TitleGenerator,
} from "../title-generator.ts";
import { makeQueueServiceRuntime } from "./queue-service-runtime.ts";

/**
 * A persisted message together with the global event-log `sequence` its
 * `MessagePersisted` event was assigned — the cursor clients resume from.
 */
interface PersistedMessage {
	readonly message: Message;
	readonly sequence: number;
}

const ProviderStartRequest = Schema.Struct({
	initialPrompt: Schema.NullOr(Schema.String),
	modelOptionsJson: Schema.NullOr(Schema.String),
	enableSubagents: Schema.Boolean,
	forkFromResume: Schema.Boolean,
	background: Schema.Boolean,
	postBootStatus: Schema.Literals(["idle", "running"]),
});
type ProviderStartRequest = typeof ProviderStartRequest.Type;
const decodeProviderStartRequest = Schema.decodeUnknownEffect(
	Schema.fromJsonString(ProviderStartRequest),
);
const decodeProviderModelOptions = Schema.decodeUnknownEffect(
	Schema.fromJsonString(Schema.Record(Schema.String, Schema.String)),
);
const decodeArchiveCleanupDetail = Schema.decodeUnknownEffect(
	Schema.fromJsonString(Schema.Struct({ output: Schema.String })),
);
export const ConversationServicesLive = Layer.effectContext(
	Effect.gen(function* () {
		const serviceScope = yield* Effect.scope;
		const sql = yield* SqlClient.SqlClient;
		const state = yield* ConversationState;
		const sessionQueries = yield* SqlSessionQueries;
		const sessionDomain = yield* SessionDomain;
		const chatDomain = yield* ChatDomain;
		const reactorEffects = makeReactorEffectJournal(sql);
		const currentTimestamp = DateTime.nowAsDate.pipe(
			Effect.map((now) => now.getTime()),
		);
		const dispatchSessionCommand = (
			sessionId: SessionId,
			command: SessionCommand,
		): Effect.Effect<void> =>
			Effect.gen(function* () {
				yield* sessionDomain
					.dispatch({
						commandId: crypto.randomUUID(),
						streamId: sessionId,
						command,
					})
					.pipe(Effect.orDie);
				yield* runSessionReactors;
			});
		const dispatchChatCommand = (
			chatId: ChatId,
			command: ChatCommand,
			commandId: string = crypto.randomUUID(),
		): Effect.Effect<void> =>
			chatDomain
				.dispatch({
					commandId,
					streamId: chatId,
					command,
				})
				.pipe(Effect.asVoid, Effect.orDie);
		let runSessionReactors: Effect.Effect<void> = Effect.void;
		let runProviderStartReactor: Effect.Effect<void, SessionStartError> =
			Effect.void;
		let runProviderStopReactor: Effect.Effect<void> = Effect.void;
		let runChatArchiveReactor: Effect.Effect<void, ChatArchiveReactorError> =
			Effect.void;
		let runChatDeleteReactor: Effect.Effect<void, ChatNotFoundError> =
			Effect.void;
		const provider = yield* ProviderService;
		const attachProvider = (sessionId: SessionId, providerId: ProviderId) =>
			Effect.gen(function* () {
				yield* dispatchSessionCommand(sessionId, {
					_tag: "AttachProvider",
					providerId,
					attachedAt: yield* currentTimestamp,
				});
			});
		const closeProvider = (sessionId: SessionId) =>
			Effect.gen(function* () {
				yield* dispatchSessionCommand(sessionId, {
					_tag: "RequestProviderStop",
					requestedAt: yield* currentTimestamp,
				});
				yield* runProviderStopReactor;
			});
		const ndjson = yield* NdjsonLogger;
		const worktrees = yield* WorktreeService;
		const repositorySettings = yield* RepositorySettingsService;
		const ptys = yield* PtyService;
		const git = yield* GitService;
		const titleGen = yield* TitleGenerator;
		const configStore = yield* ConfigStoreService;
		// Captured once so the control-plane orchestration tools — which the
		// Claude SDK invokes as plain async functions — can bridge back into
		// these Effect methods via `Runtime.runPromise`. Same shape as the
		// browser-bridge tool binding in ProviderService.
		const runtime = yield* Effect.context<never>();
		const relayActivity = yield* RelayActivityPublisher;

		const chatColumns = yield* sql<{ readonly name: string }>`
      PRAGMA table_info(chats)
    `.pipe(Effect.orDie);
		const hasChatColumn = (name: string): boolean =>
			chatColumns.some((column) => column.name === name);
		if (!hasChatColumn("archived_worktree_json")) {
			yield* sql`
        ALTER TABLE chats
          ADD COLUMN archived_worktree_json TEXT
      `.pipe(Effect.orDie);
		}

		/**
		 * Resolve the cwd a session should run in. NULL `worktreeId` falls
		 * through to the project's main checkout (handled by `provider.start`
		 * when `cwdOverride` is omitted). Missing rows also fall through.
		 */
		const cwdForWorktree = (
			worktreeId: WorktreeId | null,
		): Effect.Effect<string | undefined> =>
			worktreeId === null
				? Effect.succeed(undefined)
				: Effect.map(worktrees.get(worktreeId), (wt) => wt?.path ?? undefined);

		const projectPath = (projectId: FolderId): Effect.Effect<string | null> =>
			Effect.gen(function* () {
				const rows = yield* sql<{ readonly path: string }>`
          SELECT path FROM projects WHERE id = ${projectId} LIMIT 1
        `.pipe(Effect.orDie);
				return rows[0]?.path ?? null;
			});

		const beginTurn = (sessionId: SessionId): Effect.Effect<string> => {
			const existing = state.activeTurn(sessionId);
			if (existing !== undefined) return Effect.succeed(existing);
			const turnId = `turn_${crypto.randomUUID()}`;
			return Effect.gen(function* () {
				const startedAt = yield* currentTimestamp;
				// The durable decider is the authority. After a restart (or if two
				// callers race before the cache is populated), it returns the already
				// running turn instead of letting this process invent a second one.
				const resolvedTurnId = yield* sessionDomain
					.dispatch({
						commandId: crypto.randomUUID(),
						streamId: sessionId,
						command: { _tag: "StartTurn", turnId, startedAt },
					})
					.pipe(
						Effect.as(turnId),
						Effect.catchTag("TurnAlreadyRunning", (error) =>
							Effect.succeed(error.turnId),
						),
						Effect.orDie,
					);
				if (resolvedTurnId === turnId) yield* runSessionReactors;
				state.rememberActiveTurn(sessionId, resolvedTurnId);
				return resolvedTurnId;
			});
		};

		const settleActiveTurn = (
			sessionId: SessionId,
			outcome: "completed" | "interrupted" | "error",
		): Effect.Effect<void> =>
			Effect.flatMap(currentTimestamp, (settledAt) =>
				dispatchSessionCommand(sessionId, {
					_tag: "SettleActiveTurn",
					outcome,
					settledAt,
				}),
			).pipe(
				Effect.ensuring(
					Effect.sync(() => {
						state.clearActiveTurn(sessionId);
					}),
				),
			);

		const ndjsonAppend = (
			sessionId: SessionId,
			persisted: PersistedMessage,
		): Effect.Effect<void> =>
			Effect.gen(function* () {
				const message = persisted.message;
				let projectId = state.projectId(sessionId);
				if (projectId === undefined) {
					const rows = yield* sql<{ readonly project_id: string }>`
            SELECT project_id FROM sessions WHERE id = ${sessionId} LIMIT 1
          `.pipe(
						Effect.catch(() =>
							Effect.succeed(
								[] as ReadonlyArray<{ readonly project_id: string }>,
							),
						),
					);
					const [row] = rows;
					if (row === undefined) return;
					projectId = row.project_id as FolderId;
					state.setProjectId(sessionId, projectId);
				}
				yield* ndjson.append(sessionId, projectId, message);
			});

		const goalState = yield* makeConversationGoalState();

		// Single hub for chat-row changes (create / title / worktree binding).
		// Chats are few and updates rare, so one project-filtered hub keeps it
		// simple. The renderer seeds
		// from `chat.list`; this stream carries live changes after subscription,
		// so a Zuse-orchestrated spawn appears in the sidebar without
		// requiring a full app reload.
		const chatChangesHub = yield* PubSub.unbounded<Chat>();
		const broadcastChat = (chat: Chat): Effect.Effect<void> =>
			PubSub.publish(chatChangesHub, chat).pipe(Effect.asVoid);

		// Chats whose LLM auto-name is in flight — cleared when the fiber ends.
		// Chats that already received a successful LLM title this process lifetime.

		const lookupSession = (
			sessionId: SessionId,
		): Effect.Effect<Session, SessionNotFoundError> =>
			Effect.gen(function* () {
				const record = yield* sessionQueries
					.get(sessionId)
					.pipe(
						Effect.catch((error) =>
							error._tag === "SessionQueryNotFound"
								? Effect.fail(new SessionNotFoundError({ sessionId }))
								: Effect.die(error),
						),
					);
				// Hydrate the agents cache from the row on first sight after boot
				// so resume / lazy-restart pick up the same roster the session was
				// created with.
				if (state.agents(sessionId) === undefined) {
					const parsed = parseAgents(record.agentsJson);
					if (parsed !== null && "agents" in parsed) {
						const hydrated = parsed as unknown as {
							agents: Record<string, AgentDefinition>;
							enableSubagents?: boolean;
						};
						state.setAgents(sessionId, {
							agents: hydrated.agents,
							enableSubagents: hydrated.enableSubagents ?? true,
						});
					}
				}
				return sessionFromRecord(record);
			});

		const agentsFor = (sessionId: SessionId) => state.agents(sessionId);

		const toolUseFingerprint = (
			content: Extract<MessageContent, { readonly _tag: "tool_use" }>,
		): string => {
			try {
				return JSON.stringify({
					itemId: content.itemId,
					tool: content.tool,
					input: canonicalizeToolInput(content.input),
					parentItemId: content.parentItemId ?? null,
				});
			} catch {
				return `${content.itemId}:${content.tool}:${String(content.input)}:${content.parentItemId ?? ""}`;
			}
		};

		const isDuplicateToolUse = (
			sessionId: SessionId,
			content: Extract<MessageContent, { readonly _tag: "tool_use" }>,
		): Effect.Effect<boolean> =>
			Effect.gen(function* () {
				const rows = yield* sql<{ readonly content_json: string }>`
          SELECT content_json FROM messages
          WHERE session_id = ${sessionId}
            AND kind = 'tool_use'
            AND json_valid(content_json)
            AND json_extract(content_json, '$.itemId') = ${content.itemId}
          ORDER BY sequence DESC
        `.pipe(Effect.orDie);
				const nextFingerprint = toolUseFingerprint(content);
				for (const row of rows) {
					try {
						const existing = JSON.parse(row.content_json) as MessageContent;
						if (
							existing._tag === "tool_use" &&
							existing.itemId === content.itemId &&
							toolUseFingerprint(existing) === nextFingerprint
						) {
							return true;
						}
					} catch {
						// Ignore malformed legacy rows; the normal schema path keeps JSON valid.
					}
				}
				return false;
			});

		const persistMessage = (
			sessionId: SessionId,
			content: MessageContent,
			idOverride?: MessageId,
		): Effect.Effect<PersistedMessage> =>
			Effect.gen(function* () {
				// `idOverride` is the renderer-minted `clientMessageId` for an
				// optimistic user message — reuse it so the live-stream echo carries
				// the same id the renderer already inserted. All other persists
				// (assistant/tool/error/goal) omit it and get a fresh server id.
				const id = idOverride ?? MessageId.make(crypto.randomUUID());
				const role = roleForContent(content);
				const now = new Date();
				const parentItemId = parentItemIdOfContent(content);
				yield* sessionDomain
					.dispatch({
						commandId: `message:persist:${id}`,
						streamId: sessionId,
						command: {
							_tag: "PersistMessage",
							messageId: id,
							turnId: state.activeTurn(sessionId) ?? null,
							role,
							kind: content._tag,
							contentJson: JSON.stringify(content),
							parentItemId,
							createdAt: now.getTime(),
						},
					})
					.pipe(Effect.orDie);
				const projected = yield* sql<{ readonly sequence: number }>`
          SELECT sequence FROM messages WHERE id = ${id} LIMIT 1
        `.pipe(Effect.orDie);
				const sequence = projected[0]?.sequence;
				if (sequence === undefined) {
					return yield* Effect.die(
						new Error(`message projection missing after dispatch: ${id}`),
					);
				}
				return {
					message: Message.make({
						id,
						sessionId,
						role,
						content,
						createdAt: now,
					}),
					sequence,
				};
			});

		let flushQueueAfterIdle: (sessionId: SessionId) => Effect.Effect<void> =
			() => Effect.void;
		let shutdownQueueSession: (sessionId: SessionId) => Effect.Effect<void> =
			() => Effect.void;

		const setStatus = (
			sessionId: SessionId,
			status: Session["status"],
		): Effect.Effect<void> =>
			Effect.gen(function* () {
				yield* dispatchSessionCommand(sessionId, {
					_tag: "SetStatus",
					status,
					updatedAt: yield* currentTimestamp,
				});
				if (status === "idle" || status === "closed") {
					yield* Effect.forkIn(flushQueueAfterIdle(sessionId), serviceScope);
				}
			});

		const publishRelayActivity = (
			sessionId: SessionId,
			kind:
				| "approval-needed"
				| "question-needed"
				| "completed"
				| "error"
				| "running",
		): Effect.Effect<void> =>
			relayActivity
				.publish({ sessionId, kind })
				.pipe(
					Effect.catch((error) =>
						Effect.logDebug(
							`[ConversationServices] relay activity publish failed: ${error.reason}`,
						),
					),
				);

		/**
		 * Fork a daemon that consumes the provider's event stream for one
		 * session and persists each renderable event into `messages` while
		 * fanning a copy out to live subscribers. Lifecycle events drive
		 * `sessions.status`. Failure paths are swallowed at the daemon
		 * boundary — the alternative is a runaway error that bubbles into the
		 * RPC server and tears down the whole transport.
		 */
		const eventRuntime = yield* makeConversationEventRuntime({
			scope: serviceScope,
			events: (sessionId) => provider.events(sessionId),
			providerId: (sessionId) =>
				lookupSession(sessionId).pipe(
					Effect.orDie,
					Effect.map((session) => session.providerId),
				),
			setStatus,
			settleTurn: settleActiveTurn,
			setResume: (sessionId, cursor, strategy) =>
				Effect.gen(function* () {
					yield* dispatchSessionCommand(sessionId, {
						_tag: "SetResume",
						cursor,
						resumeStrategy: strategy,
						updatedAt: yield* currentTimestamp,
					});
				}),
			setPermissionMode: (sessionId, mode) =>
				Effect.gen(function* () {
					yield* dispatchSessionCommand(sessionId, {
						_tag: "SetPermissionMode",
						permissionMode: mode,
						updatedAt: yield* currentTimestamp,
					});
				}),
			publishGoal: (sessionId, goal) =>
				goalState.publish(
					sessionId,
					goal === null ? null : ThreadGoal.make(goal),
				),
			publishRelayActivity,
			ignoreError: (providerId, message) =>
				providerId === "grok" && isIgnorableGrokAuthNoise(message),
			isDuplicateToolUse,
			persist: (sessionId, content) =>
				Effect.gen(function* () {
					const persisted = yield* persistMessage(sessionId, content);
					yield* ndjsonAppend(sessionId, persisted);
				}),
		});
		const startSubscription = eventRuntime.start;
		const interruptProviderFiber = eventRuntime.interrupt;

		const teardownSubscription = (sessionId: SessionId): Effect.Effect<void> =>
			Effect.gen(function* () {
				yield* interruptProviderFiber(sessionId);
				yield* shutdownQueueSession(sessionId);
			});

		// Boot recovery: any session left in `running` is stale (the previous
		// run's provider session died with the process). Demote to `idle` so the
		// sidebar reflects reality, but DO NOT pollute the message timeline with
		// synthetic rows — `sendMessage` will lazily restart the provider on the
		// next user turn (see below).
		const staleSessions = yield* sql<{
			readonly id: string;
			readonly status: "running" | "booting";
		}>`
      SELECT id, status FROM sessions
      WHERE status IN ('running', 'booting') AND archived_at IS NULL
    `.pipe(Effect.orDie);
		for (const stale of staleSessions) {
			if (stale.status === "running") {
				yield* settleActiveTurn(SessionId.make(stale.id), "error");
			}
			yield* dispatchSessionCommand(SessionId.make(stale.id), {
				_tag: "SetStatus",
				status: stale.status === "running" ? "idle" : "error",
				updatedAt: yield* currentTimestamp,
			});
		}

		const listSessions: ConversationOperations["listSessions"] = (
			projectId,
			includeArchived,
		) =>
			sessionQueries.list({ projectId, includeArchived }).pipe(
				Effect.map((records) => records.map(sessionFromRecord)),
				Effect.orDie,
			);

		/**
		 * Resolve a chat row for createSession. Failures surface as
		 * SessionStartError so the renderer treats unknown / archived chat ids
		 * the same as provider boot failures.
		 */
		const lookupChatForSession = (
			chatId: ChatId,
			providerId: ProviderId,
		): Effect.Effect<ChatRow, SessionStartError> =>
			Effect.gen(function* () {
				const rows = yield* sql<ChatRow>`
          SELECT id, project_id, worktree_id, title, active_session_id, origin_session_id,
                 archived_at, archived_worktree_json, last_message_at, last_read_at, created_at, updated_at
          FROM chats WHERE id = ${chatId} LIMIT 1
        `.pipe(Effect.orDie);
				const row = rows[0];
				if (row === undefined) {
					return yield* Effect.fail(
						new SessionStartError({
							providerId,
							reason: `chat ${chatId} not found`,
						}),
					);
				}
				if (row.archived_at !== null) {
					return yield* Effect.fail(
						new SessionStartError({
							providerId,
							reason: "cannot create a session in an archived chat",
						}),
					);
				}
				return row;
			});

		interface OpenProviderSessionOptions {
			readonly initialPrompt?: string;
			readonly modelOptions?: Readonly<Record<string, string>>;
			readonly enableSubagents?: boolean;
			readonly forkFromResume?: boolean;
			readonly postBootStatus?: Session["status"];
			readonly sendAfterOpen?: {
				readonly text: string;
				readonly attachments: ReadonlyArray<AttachmentRef>;
			};
		}

		const openProviderSession = (
			session: Session,
			options: OpenProviderSessionOptions = {},
		): Effect.Effect<void, SessionStartError> =>
			Effect.gen(function* () {
				state.setRuntimeMode(session.id, session.runtimeMode);
				const subagents = agentsFor(session.id);
				const cwdOverride = yield* cwdForWorktree(session.worktreeId);
				const orchestrationTools = yield* makeConversationOrchestration(
					{
						runtime,
						getSettings: configStore.getSettings,
						createWorktree: (projectId, source) =>
							worktrees.create(projectId, source),
						createChat: (input) => createChat(input),
						createSession: (input) => createSession(input),
						getChat: lookupChat,
						getSession: lookupSession,
						sendToSession: (sessionId, text, origin) =>
							sendMessage(
								sessionId,
								text,
								undefined,
								undefined,
								undefined,
								undefined,
								undefined,
								undefined,
								origin,
							),
						listMessages,
						listChats,
						listSessions,
					},
					{
						sessionId: session.id,
						chatId: session.chatId,
						projectId: session.projectId,
						worktreeId: session.worktreeId,
						providerId: session.providerId,
						model: session.model,
					},
				);
				yield* provider
					.start(
						{
							folderId: session.projectId,
							providerId: session.providerId,
							mode: "sdk",
							sessionId: session.id,
							initialPrompt: options.initialPrompt,
							model: session.model,
							agents: subagents?.agents,
							enableSubagents:
								options.enableSubagents ?? subagents?.enableSubagents,
							cwdOverride,
							permissionMode: session.permissionMode,
							modelOptions: options.modelOptions,
							toolSearch: session.toolSearch,
							forkFromResume: options.forkFromResume,
						},
						session.cursor,
						() => state.runtimeMode(session.id),
						orchestrationTools,
					)
					.pipe(
						Effect.mapError((error) =>
							error._tag === "ProviderNotAvailableError"
								? new SessionStartError({
										providerId: session.providerId,
										reason: error.reason,
									})
								: error._tag === "AgentSessionStartError"
									? new SessionStartError({
											providerId: error.providerId,
											reason: error.reason,
										})
									: new SessionStartError({
											providerId: session.providerId,
											reason: formatProviderFailure(error),
										}),
						),
					);
				yield* attachProvider(session.id, session.providerId);
				if (options.postBootStatus !== undefined) {
					yield* setStatus(session.id, options.postBootStatus);
				}
				yield* startSubscription(session.id);
				if (options.sendAfterOpen !== undefined) {
					yield* provider
						.send(
							session.id,
							options.sendAfterOpen.text,
							options.sendAfterOpen.attachments,
						)
						.pipe(
							Effect.catchTag("AgentSessionNotFoundError", () =>
								Effect.fail(
									new SessionStartError({
										providerId: session.providerId,
										reason: "Provider session disappeared after start.",
									}),
								),
							),
						);
				}
			});

		const createSession: ConversationOperations["createSession"] = (
			input: CreateSessionInput,
		) => {
			const sessionId = SessionId.make(`s_${crypto.randomUUID()}`);
			return Effect.gen(function* () {
				// Project + worktree are inherited from the chat row — clients no
				// longer pass them at session-create time. Fail-fast on missing /
				// archived chats so we never leave a stray provider session behind.
				const chatRow = yield* lookupChatForSession(
					input.chatId,
					input.providerId,
				);
				const projectId = chatRow.project_id as FolderId;
				const worktreeId: WorktreeId | null =
					chatRow.worktree_id === null
						? null
						: (chatRow.worktree_id as unknown as WorktreeId);
				// Mint the session id up-front so the row + caches exist BEFORE
				// `provider.start` runs. Background-mode callers (`session.create`)
				// can then return immediately and let the slow CLI boot flip the
				// status out of `"booting"` from a daemon fiber.
				const effectiveEnableSubagents =
					input.enableSubagents ??
					(input.agents !== undefined && Object.keys(input.agents).length > 0);
				const initialPermissionMode =
					input.permissionMode ?? DEFAULT_PERMISSION_MODE;
				const initialToolSearch = input.toolSearch ?? false;
				const initialRuntimeMode = input.runtimeMode ?? DEFAULT_RUNTIME_MODE;
				state.setRuntimeMode(sessionId, initialRuntimeMode);
				if (
					input.agents !== undefined &&
					Object.keys(input.agents).length > 0
				) {
					state.setAgents(sessionId, {
						agents: input.agents,
						enableSubagents: effectiveEnableSubagents,
					});
				}
				const now = new Date();
				const title =
					input.title?.trim() || deriveProvisionalTitle(input.initialPrompt);
				const agentsJson =
					input.agents !== undefined && Object.keys(input.agents).length > 0
						? JSON.stringify({
								agents: input.agents,
								enableSubagents: effectiveEnableSubagents,
							})
						: null;
				const hasInitial =
					input.initialPrompt !== undefined &&
					input.initialPrompt.trim().length > 0;
				// Lineage: when this chat was spawned by another agent (orchestration
				// sets chats.origin_session_id), stamp the initial user message with
				// the origin so the renderer can attribute + link it. Skip silently
				// if the origin session row is gone.
				let origin: MessageOrigin | undefined;
				const originSessionId =
					input.originSessionId ?? chatRow.origin_session_id;
				if (hasInitial && originSessionId !== null) {
					const originRows = yield* sql<{
						readonly chat_id: string;
						readonly provider_id: string;
					}>`
            SELECT chat_id, provider_id FROM sessions WHERE id = ${originSessionId}
          `.pipe(Effect.orDie);
					const originRow = originRows[0];
					if (originRow !== undefined) {
						origin = {
							chatId: originRow.chat_id as ChatId,
							sessionId: originSessionId as SessionId,
							providerId: originRow.provider_id as ProviderId,
						};
					}
				}
				const promptForProvider = input.initialPrompt;
				const background = input.background === true;
				const resumeCursor = input.resumeCursor ?? null;
				const resumeStrategy: ResumeStrategy =
					resumeCursor === null ? "none" : (input.resumeStrategy ?? "none");
				const forkedFromSessionId = input.forkedFromSessionId ?? null;
				const forkedFromMessageId = input.forkedFromMessageId ?? null;
				// Only fork the transcript when we actually have a cursor to fork.
				const forkFromResume =
					input.forkFromResume === true && resumeCursor !== null;
				const postBootStatus: Session["status"] = hasInitial
					? "running"
					: "idle";
				const providerStart: ProviderStartRequest = {
					initialPrompt: promptForProvider ?? null,
					modelOptionsJson:
						input.modelOptions === undefined
							? null
							: JSON.stringify(input.modelOptions),
					enableSubagents: effectiveEnableSubagents,
					forkFromResume,
					background,
					postBootStatus,
				};
				// Synchronous mode (chat.create) inserts with the final post-boot
				// status because it waits for `provider.start` below — the row is
				// never visible to the renderer in `booting`. Background mode
				// (session.create) inserts as `booting`; the daemon flips it.
				const rowStatus: Session["status"] = background
					? "booting"
					: postBootStatus;
				const createSessionRecord = sessionDomain
					.dispatch({
						commandId: `session:create:${sessionId}`,
						streamId: sessionId,
						command: {
							_tag: "CreateSession",
							sessionId,
							chatId: input.chatId,
							projectId,
							title,
							providerId: input.providerId,
							model: input.model,
							status: rowStatus,
							cursor: resumeCursor,
							resumeStrategy,
							runtimeMode: initialRuntimeMode,
							agentsJson,
							worktreeId,
							forkedFromSessionId,
							forkedFromMessageId,
							permissionMode: initialPermissionMode,
							toolSearch: initialToolSearch,
							queuePaused: false,
							providerStartJson: JSON.stringify(providerStart),
							createdAt: now.getTime(),
						},
					})
					.pipe(Effect.orDie);
				yield* createSessionRecord;
				yield* lookupChat(input.chatId).pipe(
					Effect.flatMap(broadcastChat),
					Effect.catch(() => Effect.void),
				);
				if (
					input.initialPrompt !== undefined &&
					input.initialPrompt.trim().length > 0
				) {
					const initialPrompt = input.initialPrompt;
					yield* beginTurn(sessionId);
					yield* persistMessage(sessionId, {
						_tag: "user",
						text: initialPrompt,
						goal: false,
						...(origin !== undefined ? { origin } : {}),
					});
				}
				if (background) {
					// Detach the boot so the RPC reply happens immediately. The status
					// durable event feed carries the eventual transition to clients;
					// on failure we mark `error` and log so
					// the user sees a closable failed tab instead of a stuck spinner.
					yield* Effect.forkIn(
						runProviderStartReactor.pipe(
							Effect.catchCause((cause) =>
								Effect.logWarning(
									`[ConversationServices] provider start reactor failed: ${String(cause)}`,
								),
							),
						),
						serviceScope,
						{ startImmediately: true },
					);
					return Session.make({
						id: sessionId,
						projectId,
						title,
						providerId: input.providerId,
						model: input.model,
						status: "booting",
						archivedAt: null,
						cursor: resumeCursor,
						resumeStrategy,
						runtimeMode: initialRuntimeMode,
						worktreeId,
						chatId: input.chatId,
						forkedFromSessionId,
						forkedFromMessageId,
						permissionMode: initialPermissionMode,
						toolSearch: initialToolSearch,
						createdAt: now,
						updatedAt: now,
					});
				}
				// Synchronous boot — used by `chat.create` so its existing staged
				// loading panel (which animates over the full ~60s wait) stays in
				// lockstep with the actual provider handshake. Boot failures bubble
				// back as `SessionStartError`; the caller (`createChat`) rolls back
				// the chat row in that case.
				yield* runProviderStartReactor;
				return Session.make({
					id: sessionId,
					projectId,
					title,
					providerId: input.providerId,
					model: input.model,
					status: postBootStatus,
					archivedAt: null,
					cursor: resumeCursor,
					resumeStrategy,
					runtimeMode: initialRuntimeMode,
					worktreeId,
					chatId: input.chatId,
					forkedFromSessionId,
					forkedFromMessageId,
					permissionMode: initialPermissionMode,
					toolSearch: initialToolSearch,
					createdAt: now,
					updatedAt: now,
				});
			}).pipe(
				Effect.catchCause((cause) =>
					Effect.sync(() => state.clearSession(sessionId)).pipe(
						Effect.andThen(Effect.failCause(cause)),
					),
				),
			);
		};

		const renameSession: ConversationOperations["renameSession"] = (
			sessionId,
			title,
		) =>
			Effect.gen(function* () {
				yield* lookupSession(sessionId);
				yield* dispatchSessionCommand(sessionId, {
					_tag: "SetTitle",
					title,
					updatedAt: yield* currentTimestamp,
				});
			});

		/**
		 * Update the per-session runtime mode. Persists immediately. The driver's
		 * `canUseTool` callback observes the new value via `provider.start`'s
		 * runtime-mode getter on the next tool call — no need to restart the SDK.
		 */
		const setRuntimeMode: ConversationOperations["setRuntimeMode"] = (
			sessionId,
			runtimeMode,
		) =>
			Effect.gen(function* () {
				yield* lookupSession(sessionId);
				yield* dispatchSessionCommand(sessionId, {
					_tag: "SetRuntimeMode",
					runtimeMode,
					updatedAt: yield* currentTimestamp,
				});
				// Poke the in-memory cache so the next `canUseTool` invocation picks
				// up the new mode without restarting the SDK.
				state.setRuntimeMode(sessionId, runtimeMode);
			});

		/**
		 * Switch SDK lifecycle mode mid-session. Persists, updates the cache,
		 * then forwards to `provider.setPermissionMode` which calls
		 * `Query.setPermissionMode` on the live SDK handle and emits a
		 * `PermissionModeChanged` event the renderer subscribes to.
		 */
		const setPermissionMode: ConversationOperations["setPermissionMode"] = (
			sessionId,
			mode,
		) =>
			Effect.gen(function* () {
				yield* lookupSession(sessionId);
				yield* dispatchSessionCommand(sessionId, {
					_tag: "SetPermissionMode",
					permissionMode: mode,
					updatedAt: yield* currentTimestamp,
				});
				yield* provider.setPermissionMode(sessionId, mode).pipe(
					// The SDK session may have been closed (idle / closed status).
					// Persisting the mode is enough — when the renderer hits Send,
					// `restartProviderSession` will pass the persisted value back
					// into `provider.start`'s Options.
					Effect.catch(() => Effect.void),
				);
			});

		/**
		 * Resolve a pending AskUserQuestion. Persist the answer first so a
		 * crash mid-flight doesn't leave the renderer with no record; then
		 * forward to the driver, which resolves the deferred Promise and
		 * lets the SDK turn unwind with the answers as the tool result.
		 */
		const answerQuestion: ConversationOperations["answerQuestion"] = (
			sessionId,
			itemId,
			answers,
		) =>
			Effect.gen(function* () {
				yield* lookupSession(sessionId);
				const persisted = yield* persistMessage(sessionId, {
					_tag: "user_question_answer",
					itemId,
					answers,
				});
				// Broadcast so the renderer sees the answer arrive on
				// `messages.stream` and the ChatComposer's `pendingQuestion`
				// selector flips to null — switching the composer slot back
				// from the QuestionCard to the regular editor. Without this,
				// the row sits in the DB until the next hydrate.
				yield* ndjsonAppend(sessionId, persisted);
				yield* provider
					.answerQuestion(sessionId, itemId, answers)
					.pipe(Effect.catch(() => Effect.void));
			});

		/**
		 * Switch the worktree the session runs in. Allowed only before the
		 * first user message is recorded — cwd cannot move under a running
		 * agent. The renderer guards via `messagesCount > 0`, but we re-check
		 * server-side so a stale client can't race past the lock.
		 */
		const setWorktree: ConversationOperations["setWorktree"] = (
			sessionId,
			worktreeId,
		) =>
			Effect.gen(function* () {
				yield* lookupSession(sessionId);
				const existing = yield* sql<{ readonly id: string }>`
          SELECT id FROM messages
          WHERE session_id = ${sessionId} AND role = 'user'
          LIMIT 1
        `.pipe(Effect.orDie);
				if (existing.length > 0) {
					return yield* Effect.fail(
						new SessionAlreadyStartedError({ sessionId }),
					);
				}
				yield* dispatchSessionCommand(sessionId, {
					_tag: "SetWorktree",
					worktreeId,
					updatedAt: yield* currentTimestamp,
				});
				yield* closeProvider(sessionId);
				yield* interruptProviderFiber(sessionId);
				yield* setStatus(sessionId, "idle");
			});

		/**
		 * Persist a new model on the session row and tear down the in-memory
		 * provider session so the next user turn lazy-restarts the SDK with the
		 * new model. Existing message history stays attached to the same row.
		 */
		const setModel: ConversationOperations["setModel"] = (sessionId, model) =>
			Effect.gen(function* () {
				yield* lookupSession(sessionId);
				yield* dispatchSessionCommand(sessionId, {
					_tag: "SetModel",
					model,
					updatedAt: yield* currentTimestamp,
				});
				// Drop the provider's in-memory session and interrupt the event pump
				// fiber; durable session-event subscriptions remain connected.
				// sendMessage's "send fails → restart"
				// path reads sessions.model so the next turn picks up the new model.
				yield* closeProvider(sessionId);
				yield* interruptProviderFiber(sessionId);
				yield* setStatus(sessionId, "idle");
			});

		/**
		 * Switch a session's provider (and the model it runs under) before any
		 * user message has been sent. The new CLI can't read the prior CLI's
		 * transcript, so this is fresh-session-only — mid-chat callers get
		 * `SessionAlreadyStartedError`. Resets `cursor` / `resume_strategy`
		 * since both are provider-specific.
		 */
		const setProvider: ConversationOperations["setProvider"] = (
			sessionId,
			providerId,
			model,
		) =>
			Effect.gen(function* () {
				yield* lookupSession(sessionId);
				const existing = yield* sql<{ readonly id: string }>`
          SELECT id FROM messages
          WHERE session_id = ${sessionId} AND role = 'user'
          LIMIT 1
        `.pipe(Effect.orDie);
				if (existing.length > 0) {
					return yield* Effect.fail(
						new SessionAlreadyStartedError({ sessionId }),
					);
				}
				yield* dispatchSessionCommand(sessionId, {
					_tag: "SetProvider",
					providerId,
					model,
					updatedAt: yield* currentTimestamp,
				});
				// See setModel: the durable stream stays connected across the swap.
				yield* closeProvider(sessionId);
				yield* interruptProviderFiber(sessionId);
				yield* setStatus(sessionId, "idle");
			});

		const archiveSession: ConversationOperations["archiveSession"] = (
			sessionId,
		) =>
			Effect.gen(function* () {
				yield* lookupSession(sessionId);
				yield* dispatchSessionCommand(sessionId, {
					_tag: "ArchiveSession",
					archivedAt: yield* currentTimestamp,
				});
			});

		const unarchiveSession: ConversationOperations["unarchiveSession"] = (
			sessionId,
		) =>
			Effect.gen(function* () {
				yield* lookupSession(sessionId);
				yield* dispatchSessionCommand(sessionId, {
					_tag: "UnarchiveSession",
					unarchivedAt: yield* currentTimestamp,
				});
			});

		const deleteSession: ConversationOperations["deleteSession"] = (
			sessionId,
		) =>
			Effect.gen(function* () {
				yield* lookupSession(sessionId);
				// Best-effort: provider may not know the id (already closed) — that's
				// not an error from the user's perspective.
				yield* closeProvider(sessionId);
				yield* teardownSubscription(sessionId);
				yield* dispatchSessionCommand(sessionId, {
					_tag: "DeleteSession",
					deletedAt: yield* currentTimestamp,
				});
				yield* Effect.sync(() => state.clearSession(sessionId));
			});

		// -------------------------------------------------------------------------
		// Chats — sidebar containers. Each chat hosts ≥ 1 session as a tab.
		// -------------------------------------------------------------------------

		const lookupChat = (
			chatId: ChatId,
		): Effect.Effect<Chat, ChatNotFoundError> =>
			Effect.gen(function* () {
				const rows = yield* sql<ChatRow>`
          SELECT id, project_id, worktree_id, title, active_session_id, origin_session_id,
                 archived_at, archived_worktree_json, last_message_at, last_read_at, created_at, updated_at
          FROM chats WHERE id = ${chatId} LIMIT 1
        `.pipe(Effect.orDie);
				const [row] = rows;
				if (row === undefined) {
					return yield* Effect.fail(new ChatNotFoundError({ chatId }));
				}
				return chatFromRow(row);
			});

		const listChats: ConversationOperations["listChats"] = (
			projectId,
			includeArchived,
		) =>
			Effect.gen(function* () {
				const rows = includeArchived
					? yield* sql<ChatRow>`
              SELECT id, project_id, worktree_id, title, active_session_id, origin_session_id,
                     archived_at, archived_worktree_json, last_message_at, last_read_at, created_at, updated_at
              FROM chats WHERE project_id = ${projectId}
              ORDER BY updated_at DESC
            `.pipe(Effect.orDie)
					: yield* sql<ChatRow>`
              SELECT id, project_id, worktree_id, title, active_session_id, origin_session_id,
                     archived_at, archived_worktree_json, last_message_at, last_read_at, created_at, updated_at
              FROM chats
              WHERE project_id = ${projectId} AND archived_at IS NULL
              ORDER BY updated_at DESC
            `.pipe(Effect.orDie);
				return rows.map(chatFromRow);
			});

		const getChat: ConversationOperations["getChat"] = (chatId) =>
			lookupChat(chatId);

		/**
		 * Create a chat row AND its initial session in one effect. Both rows
		 * land or neither does — we INSERT the chat first, attempt the
		 * provider boot, and if the boot fails we DELETE the chat to leave
		 * the DB clean.
		 */
		const createChat: ConversationOperations["createChat"] = (
			input: CreateChatInput,
		) =>
			Effect.gen(function* () {
				const createdAt = yield* currentTimestamp;
				const chatId = crypto.randomUUID() as unknown as ChatId;
				const title =
					input.title?.trim() || deriveProvisionalTitle(input.initialPrompt);
				const worktreeId = input.worktreeId ?? null;
				const originSessionId = input.originSessionId ?? null;
				yield* dispatchChatCommand(chatId, {
					_tag: "CreateChat",
					chatId,
					projectId: input.projectId,
					worktreeId,
					title,
					originSessionId,
					lastReadAt: createdAt,
					createdAt,
				});
				const initialSession = yield* createSession({
					chatId,
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
					resumeCursor: input.resumeCursor,
					resumeStrategy: input.resumeStrategy,
					forkedFromSessionId: input.forkedFromSessionId,
					forkedFromMessageId: input.forkedFromMessageId,
					forkFromResume: input.forkFromResume,
				}).pipe(
					Effect.tapError(() =>
						// Roll back the chat row if the provider failed to boot —
						// otherwise the sidebar would show an empty container the
						// user can't escape from.
						dispatchChatCommand(chatId, {
							_tag: "DeleteChat",
							deletedAt: createdAt,
						}),
					),
				);
				const chat = yield* lookupChat(chatId).pipe(Effect.orDie);
				yield* broadcastChat(chat);
				// Fetch the initial user message (if any) so the renderer can seed
				// its messages store and skip the empty-state flash while the live
				// message stream is connecting. `createSession` writes the row
				// synchronously when `initialPrompt` is supplied, so by here it
				// exists in the table.
				const hasInitial =
					input.initialPrompt !== undefined &&
					input.initialPrompt.trim().length > 0;
				const initialMessage = hasInitial
					? yield* sql<MessageRow>`
              SELECT id, session_id, role, kind, content_json, parent_item_id, created_at
              FROM messages
              WHERE session_id = ${initialSession.id} AND role = 'user'
              ORDER BY created_at ASC
              LIMIT 1
            `.pipe(
							Effect.orDie,
							Effect.map((rows) => {
								const [row] = rows;
								return row === undefined ? null : messageFromRow(row);
							}),
						)
					: null;
				yield* broadcastChat(chat);
				return { chat, initialSession, initialMessage };
			});

		const continueExternalThread: ConversationOperations["continueExternalThread"] =
			(input) =>
				Effect.gen(function* () {
					const result = yield* createChat({
						...input,
						resumeCursor: input.resumeCursor,
						resumeStrategy: input.resumeStrategy,
					});
					return {
						chat: result.chat,
						initialSession: result.initialSession,
					};
				});

		const importExternalMessages: ConversationOperations["importExternalMessages"] =
			(sessionId, messages) =>
				Effect.gen(function* () {
					yield* lookupSession(sessionId);
					const imported: Message[] = [];
					for (const content of messages) {
						const persisted = yield* persistMessage(sessionId, content);
						imported.push(persisted.message);
					}
					return imported;
				});

		const exportTranscript: ConversationOperations["exportTranscript"] = (
			sessionId,
			uptoMessageId,
		) =>
			Effect.gen(function* () {
				const session = yield* lookupSession(sessionId);
				const rows = yield* sql<MessageRow>`
          SELECT id, session_id, role, kind, content_json, parent_item_id, created_at
          FROM messages WHERE session_id = ${sessionId}
          ORDER BY created_at ASC, sequence ASC
        `.pipe(Effect.orDie);
				let slice = rows;
				if (uptoMessageId !== undefined) {
					const idx = rows.findIndex((r) => r.id === uptoMessageId);
					if (idx !== -1) slice = rows.slice(0, idx + 1);
				}
				return transcriptToMarkdown(session.title, slice.map(messageFromRow));
			});

		const latestPlan: ConversationOperations["latestPlan"] = (sessionId) =>
			Effect.gen(function* () {
				yield* lookupSession(sessionId);
				const rows = yield* sql<MessageRow>`
          SELECT id, session_id, role, kind, content_json, parent_item_id, created_at
          FROM messages
          WHERE session_id = ${sessionId} AND kind = 'tool_use'
          ORDER BY created_at DESC, sequence DESC
        `.pipe(Effect.orDie);
				for (const row of rows) {
					const c = messageFromRow(row).content;
					if (c._tag === "tool_use" && c.tool === "ExitPlanMode") {
						const input = c.input;
						if (
							typeof input === "object" &&
							input !== null &&
							"plan" in input &&
							typeof (input as { plan?: unknown }).plan === "string"
						) {
							return (input as { plan: string }).plan;
						}
					}
				}
				return null;
			});

		const forkSession: ConversationOperations["forkSession"] = (input) =>
			Effect.gen(function* () {
				// Source must exist; `lookupSession` fails `SessionNotFoundError`.
				const source = yield* lookupSession(input.sourceSessionId);

				const rows = yield* sql<MessageRow>`
          SELECT id, session_id, role, kind, content_json, parent_item_id, created_at
          FROM messages WHERE session_id = ${input.sourceSessionId}
          ORDER BY created_at ASC, sequence ASC
        `.pipe(Effect.orDie);
				const forkIdx = rows.findIndex((r) => r.id === input.fromMessageId);
				if (forkIdx === -1) {
					return yield* Effect.fail(
						new SessionStartError({
							providerId: source.providerId,
							reason: `fork message ${input.fromMessageId} not found in session ${input.sourceSessionId}`,
						}),
					);
				}

				const providerId = input.providerId ?? source.providerId;
				const model = input.model ?? source.model;
				// Real provider memory is only possible when the fork point is the
				// conversation tail, the provider is the SAME as the source (a fork
				// resumes the source's own transcript), the provider supports native
				// fork, and we have a cursor to fork from. Otherwise we replay the
				// visible transcript into a fresh session (`copy`).
				const isTail = forkIdx === rows.length - 1;
				const providerCanFork =
					providerId === "claude" || providerId === "codex";
				const forkMode: "resume" | "copy" =
					isTail &&
					providerId === source.providerId &&
					providerCanFork &&
					source.cursor !== null &&
					source.resumeStrategy !== "none"
						? "resume"
						: "copy";

				const title =
					input.title?.trim() || `Fork of ${source.title}`.slice(0, 120);

				// Visible transcript up to (and including) the fork message — shown in
				// the new session's chat view for BOTH modes. In `resume` mode the
				// provider also carries real KV memory; the copied rows are display
				// only and are never re-sent to the model.
				const transcript = rows
					.slice(0, forkIdx + 1)
					.map(messageFromRow)
					.filter((message) => shouldIncludeInTranscript(message.content))
					.map((m) => m.content);

				const resumeCursor = forkMode === "resume" ? source.cursor : null;
				const resumeStrategy: ResumeStrategy =
					forkMode === "resume" ? source.resumeStrategy : "none";

				let chat: Chat;
				let session: Session;
				if (input.destination === "tab") {
					session = yield* createSession({
						chatId: source.chatId,
						providerId,
						model,
						title,
						runtimeMode: source.runtimeMode,
						permissionMode: source.permissionMode,
						toolSearch: source.toolSearch,
						background: true,
						resumeCursor,
						resumeStrategy,
						forkedFromSessionId: input.sourceSessionId,
						forkedFromMessageId: input.fromMessageId,
						forkFromResume: forkMode === "resume",
					});
					chat = yield* lookupChat(source.chatId).pipe(Effect.orDie);
				} else {
					const created = yield* createChat({
						projectId: source.projectId,
						providerId,
						model,
						title,
						worktreeId: input.worktreeId ?? null,
						runtimeMode: source.runtimeMode,
						permissionMode: source.permissionMode,
						toolSearch: source.toolSearch,
						resumeCursor,
						resumeStrategy,
						forkedFromSessionId: input.sourceSessionId,
						forkedFromMessageId: input.fromMessageId,
						forkFromResume: forkMode === "resume",
					});
					chat = created.chat;
					session = created.initialSession;
				}

				// Seed the new session's visible history. Failures here are
				// non-fatal — the branch still exists and is usable.
				if (transcript.length > 0) {
					yield* importExternalMessages(session.id, transcript).pipe(
						Effect.catch(() => Effect.succeed([])),
					);
				}

				return { chat, session, forkMode };
			});

		const renameChatWithCommandId = (
			chatId: ChatId,
			title: string,
			commandId: string,
		) =>
			Effect.gen(function* () {
				yield* lookupChat(chatId);
				yield* dispatchChatCommand(
					chatId,
					{
						_tag: "RenameChat",
						title,
						updatedAt: yield* currentTimestamp,
					},
					commandId,
				);
				// Push the new title to any renderer subscribed via
				// `chat.streamChanges` so the sidebar updates without a refetch.
				const updated = yield* lookupChat(chatId);
				yield* broadcastChat(updated);
			});

		const renameChat: ConversationOperations["renameChat"] = (chatId, title) =>
			renameChatWithCommandId(chatId, title, crypto.randomUUID());

		const markChatRead: ConversationOperations["markChatRead"] = (chatId) =>
			Effect.gen(function* () {
				yield* lookupChat(chatId);
				yield* dispatchChatCommand(chatId, {
					_tag: "MarkChatRead",
					readAt: yield* currentTimestamp,
				});
				return yield* lookupChat(chatId);
			});

		const streamChatChanges: ConversationOperations["streamChatChanges"] = (
			projectId,
		) =>
			Stream.unwrap(
				Effect.gen(function* () {
					const sub = yield* PubSub.subscribe(chatChangesHub);
					return Stream.fromSubscription(sub).pipe(
						Stream.filter((chat) => chat.projectId === projectId),
					);
				}),
			);

		/**
		 * LLM auto-name: summarize recent user/assistant turns into a short title
		 * and rename the chat (always) plus the worktree git branch (when the chat
		 * has its own worktree). Runs on a background fiber so the agent turn is
		 * never delayed; swallows every failure so a flaky title call can't wedge
		 * the session.
		 */
		const collectAutoNameContext = (
			chatId: ChatId,
		): Effect.Effect<{
			readonly userTexts: string[];
			readonly assistantTexts: string[];
			readonly conversationText: string;
		}> =>
			Effect.gen(function* () {
				const rows = yield* sql<{
					readonly role: string;
					readonly content_json: string;
				}>`
          SELECT m.role, m.content_json
          FROM messages m
          INNER JOIN sessions s ON s.id = m.session_id
          WHERE s.chat_id = ${chatId}
            AND m.role IN ('user', 'assistant')
          ORDER BY m.created_at ASC
          LIMIT 24
        `.pipe(Effect.orDie);
				const turns: Array<{ role: "user" | "assistant"; text: string }> = [];
				const userTexts: string[] = [];
				const assistantTexts: string[] = [];
				for (const row of rows) {
					try {
						const content = JSON.parse(row.content_json) as MessageContent;
						const text = textFromMessageContent(content);
						if (text === null || text.trim().length === 0) continue;
						if (row.role === "user") {
							userTexts.push(text);
							turns.push({ role: "user", text });
						} else if (row.role === "assistant") {
							assistantTexts.push(text);
							turns.push({ role: "assistant", text });
						}
					} catch {
						// Skip malformed rows — title gen can still fall back.
					}
				}
				return {
					userTexts,
					assistantTexts,
					conversationText: buildConversationText(turns),
				};
			});

		const autoNameChat = (
			chatId: ChatId,
			sessionId: SessionId,
			commandId: string,
		): Effect.Effect<void> =>
			Effect.gen(function* () {
				if (yield* reactorEffects.isCompleted(commandId)) return;
				const chat = yield* lookupChat(chatId).pipe(
					Effect.catch(() => Effect.succeed(null)),
				);
				if (chat === null) return;

				const context = yield* collectAutoNameContext(chatId);
				if (shouldDeferAutoName(context.userTexts, context.assistantTexts)) {
					return;
				}

				const session = yield* lookupSession(sessionId).pipe(
					Effect.catch(() => Effect.succeed(null)),
				);
				if (session === null) return;
				const title = yield* titleGen.generate({
					folderId: chat.projectId,
					providerId: session.providerId,
					model: session.model,
					conversationText: context.conversationText,
				});
				if (title.length === 0 || title === "New chat") return;

				// Title first — cheap, and the user sees the sidebar update even if
				// the branch rename below is skipped or fails.
				yield* renameChatWithCommandId(chatId, title, commandId);
				const memberSessions = yield* sql<{ readonly id: string }>`
          SELECT id FROM sessions WHERE chat_id = ${chatId}
        `.pipe(Effect.orDie);
				yield* Effect.forEach(
					memberSessions,
					({ id }) =>
						Effect.gen(function* () {
							yield* sessionDomain.dispatch({
								commandId: `${commandId}:session:${id}`,
								streamId: SessionId.make(id),
								command: {
									_tag: "SetTitle",
									title,
									updatedAt: yield* currentTimestamp,
								},
							});
						}).pipe(Effect.ignore),
					{ discard: true },
				);

				const markComplete = reactorEffects.complete(commandId);
				if (chat.worktreeId === null) {
					yield* markComplete;
					return;
				}
				const worktreeId = chat.worktreeId;
				const wt = yield* worktrees.get(worktreeId);
				if (wt === null) {
					yield* markComplete;
					return;
				}

				const settings = yield* configStore.getSettings();
				const username = yield* git
					.getUserName(chat.projectId)
					.pipe(Effect.catch(() => Effect.succeed("")));
				const branch = formatBranchName(
					title,
					username,
					settings.branchNamingStyle,
					settings.branchNamingPrefix,
				);
				// Rename the git branch, then mirror it onto the worktree row so the
				// DB and git agree. updateBranch only runs if the rename succeeded.
				yield* git.renameBranch(chat.projectId, branch, worktreeId).pipe(
					Effect.flatMap(() => worktrees.updateBranch(worktreeId, branch)),
					Effect.catch(() => Effect.void),
				);

				yield* markComplete;
			}).pipe(Effect.catchCause(() => Effect.void));

		const handleProviderStart: ConversationReactorHandlers["providerStart"] = (
			reactorInput,
		) =>
			Effect.gen(function* () {
				if (yield* reactorEffects.isCompleted(reactorInput.commandId)) return;

				const sessionId = SessionId.make(reactorInput.streamId);
				const session = yield* lookupSession(sessionId).pipe(
					Effect.catch(() => Effect.succeed(null)),
				);
				if (session === null) return;
				const request = yield* decodeProviderStartRequest(
					reactorInput.command.providerStartJson,
				).pipe(
					Effect.mapError(
						(cause) =>
							new SessionStartError({
								providerId: session.providerId,
								reason: `Invalid provider start request: ${String(cause)}`,
							}),
					),
				);
				const modelOptions =
					request.modelOptionsJson === null
						? undefined
						: yield* decodeProviderModelOptions(request.modelOptionsJson).pipe(
								Effect.mapError(
									(cause) =>
										new SessionStartError({
											providerId: session.providerId,
											reason: `Invalid provider model options: ${String(cause)}`,
										}),
								),
							);
				const start = openProviderSession(session, {
					initialPrompt: request.initialPrompt ?? undefined,
					modelOptions,
					enableSubagents: request.enableSubagents,
					forkFromResume: request.forkFromResume,
					postBootStatus: request.postBootStatus,
				});
				if (request.background) {
					yield* start.pipe(
						Effect.catch((error) =>
							Effect.gen(function* () {
								yield* Effect.logWarning(
									`[ConversationServices] provider.start failed for session ${sessionId} (${session.providerId}): ${error.reason}`,
								);
								const persistedError = yield* persistMessage(sessionId, {
									_tag: "error",
									message: error.reason,
								});
								yield* ndjsonAppend(sessionId, persistedError);
								yield* setStatus(sessionId, "error");
							}),
						),
					);
				} else {
					yield* start;
				}
				yield* reactorEffects.complete(reactorInput.commandId);
			});

		const handleProviderStop: ConversationReactorHandlers["providerStop"] = (
			reactorInput,
		) =>
			Effect.gen(function* () {
				if (yield* reactorEffects.isCompleted(reactorInput.commandId)) return;
				const sessionId = SessionId.make(reactorInput.streamId);
				yield* provider.close(sessionId).pipe(Effect.catch(() => Effect.void));
				yield* sessionDomain
					.dispatch({
						commandId: `${reactorInput.commandId}:detach`,
						streamId: sessionId,
						command: {
							_tag: "DetachProvider",
							detachedAt: reactorInput.command.requestedAt,
						},
					})
					.pipe(Effect.orDie);
				yield* reactorEffects.complete(reactorInput.commandId);
			});

		const handleAutoName: ConversationReactorHandlers["autoName"] = (input) =>
			Effect.gen(function* () {
				const sessionId = SessionId.make(input.streamId);
				const session = yield* lookupSession(sessionId).pipe(Effect.orDie);
				yield* autoNameChat(session.chatId, sessionId, input.commandId);
			});

		/**
		 * Worktrees are immutable past the first user message in any of the
		 * chat's sessions. Mirrors `session.setWorktree`'s pre-message check
		 * but lifted to the chat scope.
		 */
		const setChatWorktree: ConversationOperations["setChatWorktree"] = (
			chatId,
			worktreeId,
		) =>
			Effect.gen(function* () {
				yield* lookupChat(chatId);
				const existing = yield* sql<{ readonly id: string }>`
          SELECT m.id FROM messages m
          INNER JOIN sessions s ON s.id = m.session_id
          WHERE s.chat_id = ${chatId} AND m.role = 'user'
          LIMIT 1
        `.pipe(Effect.orDie);
				if (existing.length > 0) {
					return yield* Effect.fail(new ChatAlreadyStartedError({ chatId }));
				}
				const updatedAt = yield* currentTimestamp;
				yield* dispatchChatCommand(chatId, {
					_tag: "SetChatWorktree",
					worktreeId,
					updatedAt,
				});
				// Background-booted sessions (chat.create → session.create with
				// background=true) already spawned a provider CLI in the OLD cwd
				// before the user got a chance to pick a worktree. Kill those so
				// the next `sendMessage` lazy-restarts via `restartProviderSession`,
				// which reads the now-updated `session.worktreeId` and resolves
				// `cwdForWorktree` to the new path. Without this teardown the
				// first user message would land in the wrong working tree.
				const memberSessions = yield* sql<{ readonly id: string }>`
          SELECT id FROM sessions
          WHERE chat_id = ${chatId} AND archived_at IS NULL
        `.pipe(Effect.orDie);
				for (const row of memberSessions) {
					const sid = SessionId.make(row.id);
					yield* dispatchSessionCommand(sid, {
						_tag: "SetWorktree",
						worktreeId,
						updatedAt,
					});
					yield* closeProvider(sid);
					yield* interruptProviderFiber(sid);
					yield* setStatus(sid, "idle");
				}
				return yield* lookupChat(chatId);
			});

		const setChatActiveSession: ConversationOperations["setChatActiveSession"] =
			(chatId, sessionId) =>
				Effect.gen(function* () {
					yield* lookupChat(chatId);
					const member = yield* sql<{ readonly id: string }>`
          SELECT id FROM sessions
          WHERE id = ${sessionId} AND chat_id = ${chatId}
          LIMIT 1
        `.pipe(Effect.orDie);
					if (member.length === 0) return;
					yield* dispatchChatCommand(chatId, {
						_tag: "SetActiveSession",
						sessionId,
						updatedAt: yield* currentTimestamp,
					});
				});

		const performChatArchive = (
			chatId: ChatId,
			force: boolean,
			commandId: string,
		) =>
			Effect.gen(function* () {
				const chat = yield* lookupChat(chatId);
				if (chat.archivedAt !== null) {
					return { chat, cleanup: null };
				}

				const settings = yield* repositorySettings.get(chat.projectId);
				const worktree =
					chat.worktreeId === null
						? null
						: yield* worktrees.get(chat.worktreeId);
				const snapshot =
					worktree === null
						? null
						: {
								id: worktree.id,
								projectId: worktree.projectId,
								path: worktree.path,
								name: worktree.name,
								branch: worktree.branch,
								baseBranch: worktree.baseBranch,
								createdAt: worktree.createdAt.toISOString(),
							};
				const snapshotJson =
					snapshot === null ? null : JSON.stringify(snapshot);

				const liveSessions = yield* sql<{ readonly id: string }>`
          SELECT id FROM sessions
          WHERE chat_id = ${chatId} AND archived_at IS NULL
        `.pipe(Effect.orDie);
				for (const row of liveSessions) {
					const sessionId = SessionId.make(row.id);
					yield* closeProvider(sessionId);
					yield* interruptProviderFiber(sessionId);
				}
				if (worktree !== null) {
					yield* ptys
						.closeByCwdPrefix(worktree.path)
						.pipe(Effect.catch(() => Effect.void));
				}

				let cleanup: { readonly ran: boolean; readonly output: string } | null =
					null;
				const script = settings.archiveCleanupScript?.trim() ?? "";
				if (worktree !== null && script.length > 0) {
					const steps = yield* sql<{
						readonly status: "started" | "completed";
						readonly detail_json: string | null;
					}>`
            SELECT status, detail_json FROM reactor_effect_steps
            WHERE effect_id = ${commandId} AND step = 'cleanup-script'
            LIMIT 1
          `.pipe(Effect.orDie);
					const step = steps[0];
					if (step?.status === "completed") {
						const detail =
							step.detail_json === null
								? { output: "" }
								: yield* decodeArchiveCleanupDetail(step.detail_json).pipe(
										Effect.mapError(
											(cause) =>
												new ChatArchiveScriptError({
													chatId,
													exitCode: null,
													signal: null,
													output: `Stored cleanup result is invalid: ${String(cause)}`,
												}),
										),
									);
						cleanup = {
							ran: true,
							output: detail.output,
						};
					} else if (step?.status === "started") {
						// The process died after claiming this non-idempotent step. We
						// cannot know whether the script ran, so preserve `started` as an
						// auditable indeterminate state and never fabricate completion or
						// run the user's script twice.
						cleanup = null;
					} else {
						yield* sql`
              INSERT INTO reactor_effect_steps
                (effect_id, step, status, detail_json, updated_at)
              VALUES
                (${commandId}, 'cleanup-script', 'started', NULL,
                 ${new Date().toISOString()})
            `.pipe(Effect.orDie);
						const rootPath = yield* projectPath(chat.projectId);
						const result = yield* runArchiveScript({
							chatId,
							script: settings.archiveCleanupScript ?? "",
							cwd: worktree.path,
							env: {
								ZUSE_ROOT_PATH: rootPath ?? "",
								ZUSE_WORKSPACE_PATH: worktree.path,
								ZUSE_CHAT_ID: chatId,
								ZUSE_WORKTREE_ID: worktree.id,
							},
						});
						cleanup = { ran: true, output: result.output };
						yield* sql`
              UPDATE reactor_effect_steps
              SET status = 'completed',
                  detail_json = ${JSON.stringify({ output: result.output })},
                  updated_at = ${new Date().toISOString()}
              WHERE effect_id = ${commandId} AND step = 'cleanup-script'
            `.pipe(Effect.orDie);
					}
				} else if (worktree !== null) {
					cleanup = { ran: false, output: "" };
				}

				if (worktree !== null && settings.archiveRemoveWorktree) {
					yield* worktrees.remove(worktree.id, force).pipe(
						Effect.mapError(
							(err) =>
								new ChatArchiveWorktreeError({
									chatId,
									reason:
										"reason" in err && typeof err.reason === "string"
											? err.reason
											: err._tag,
								}),
						),
					);
				}

				const archivedAt = yield* currentTimestamp;
				yield* Effect.forEach(
					liveSessions,
					({ id }) =>
						dispatchSessionCommand(SessionId.make(id), {
							_tag: "ArchiveSession",
							archivedAt,
						}),
					{ discard: true },
				);
				yield* dispatchChatCommand(
					chatId,
					{
						_tag: "ArchiveChat",
						archivedAt,
						archivedWorktreeJson: snapshotJson,
					},
					`${commandId}:archive`,
				);
				const result = { chat: yield* lookupChat(chatId), cleanup };
				yield* reactorEffects.complete(commandId);
				return result;
			});

		const chatArchiveResults = yield* Ref.make<
			ReadonlyMap<ChatId, ChatArchiveResult>
		>(new Map());
		const handleChatArchive: ConversationReactorHandlers["chatArchive"] = (
			reactorInput,
		) =>
			Effect.gen(function* () {
				const chatId = ChatId.make(reactorInput.streamId);
				const completed = yield* reactorEffects.isCompleted(
					reactorInput.commandId,
				);
				const result = completed
					? { chat: yield* lookupChat(chatId), cleanup: null }
					: yield* performChatArchive(
							chatId,
							reactorInput.command.force,
							reactorInput.commandId,
						);
				yield* Ref.update(chatArchiveResults, (current) => {
					const next = new Map(current);
					next.set(chatId, result);
					return next;
				});
			});

		const archiveChat: ConversationOperations["archiveChat"] = (
			chatId,
			force,
		) =>
			Effect.gen(function* () {
				const chat = yield* lookupChat(chatId);
				if (chat.archivedAt !== null) return { chat, cleanup: null };
				yield* dispatchChatCommand(chatId, {
					_tag: "RequestArchiveChat",
					force,
					requestedAt: yield* currentTimestamp,
				});
				yield* runChatArchiveReactor;
				const results = yield* Ref.get(chatArchiveResults);
				const result = results.get(chatId);
				if (result === undefined) {
					return yield* Effect.die(
						new Error(`chat archive reactor produced no result for ${chatId}`),
					);
				}
				return result;
			});

		const unarchiveChat: ConversationOperations["unarchiveChat"] = (chatId) =>
			Effect.gen(function* () {
				const chatRows = yield* sql<ChatRow>`
          SELECT id, project_id, worktree_id, title, active_session_id, origin_session_id,
                 archived_at, archived_worktree_json, last_message_at, last_read_at, created_at, updated_at
          FROM chats WHERE id = ${chatId} LIMIT 1
        `.pipe(Effect.orDie);
				const chatRow = chatRows[0];
				if (chatRow === undefined) {
					return yield* Effect.fail(new ChatNotFoundError({ chatId }));
				}

				const snapshot = parseArchivedWorktreeSnapshot(
					chatRow.archived_worktree_json,
				);
				let restoredWorktree: Worktree | null = null;
				let restoredWorktreeId: WorktreeId | null =
					chatRow.worktree_id === null
						? null
						: WorktreeId.make(chatRow.worktree_id);
				if (snapshot !== null) {
					const existing = yield* worktrees.get(WorktreeId.make(snapshot.id));
					if (existing !== null) {
						restoredWorktree = existing;
						restoredWorktreeId = existing.id;
					} else if (chatRow.worktree_id === null) {
						restoredWorktree = yield* worktrees
							.restore({
								id: WorktreeId.make(snapshot.id),
								projectId: snapshot.projectId as FolderId,
								path: snapshot.path,
								name: snapshot.name,
								branch: snapshot.branch,
								baseBranch: snapshot.baseBranch,
								createdAt: new Date(snapshot.createdAt),
							})
							.pipe(
								Effect.mapError(
									(err) =>
										new ChatArchiveWorktreeError({
											chatId,
											reason: err.reason,
										}),
								),
							);
						restoredWorktreeId = restoredWorktree.id;
					}
				}

				const unarchivedAt = yield* currentTimestamp;
				yield* dispatchChatCommand(chatId, {
					_tag: "UnarchiveChat",
					unarchivedAt,
					worktreeId: restoredWorktreeId,
				});
				const archivedSessions = yield* sql<{
					readonly id: string;
					readonly worktree_id: string | null;
				}>`
          SELECT id, worktree_id FROM sessions WHERE chat_id = ${chatId}
        `.pipe(Effect.orDie);
				for (const row of archivedSessions) {
					const sessionId = SessionId.make(row.id);
					if (
						restoredWorktreeId !== null &&
						row.worktree_id !== restoredWorktreeId
					) {
						yield* dispatchSessionCommand(sessionId, {
							_tag: "SetWorktree",
							worktreeId: restoredWorktreeId,
							updatedAt: unarchivedAt,
						});
					}
					if (chatRow.archived_at !== null) {
						yield* dispatchSessionCommand(sessionId, {
							_tag: "UnarchiveSession",
							unarchivedAt,
						});
					}
				}
				const sessions = yield* sql<SessionRow>`
          SELECT id, project_id, title, provider_id, model, status,
                 archived_at, cursor, resume_strategy, runtime_mode,
                 agents_json, worktree_id, chat_id, forked_from_session_id,
                 forked_from_message_id, permission_mode, tool_search,
                 created_at, updated_at
          FROM sessions
          WHERE chat_id = ${chatId} AND archived_at IS NULL
          ORDER BY updated_at DESC
        `.pipe(Effect.orDie);
				return {
					chat: yield* lookupChat(chatId),
					sessions: sessions.map(sessionFromRow),
					worktree: restoredWorktree,
				};
			});

		const performChatDelete = (chatId: ChatId, commandId: string) =>
			Effect.gen(function* () {
				yield* lookupChat(chatId);
				// Tear down each child session's provider state before the SQL
				// CASCADE wipes the rows so we don't leak an in-memory pubsub /
				// fiber after the data is gone.
				const childIds = yield* sql<{ readonly id: string }>`
          SELECT id FROM sessions WHERE chat_id = ${chatId}
        `.pipe(Effect.orDie);
				for (const { id } of childIds) {
					const sessionId = SessionId.make(id);
					yield* closeProvider(sessionId);
					yield* teardownSubscription(sessionId);
					yield* dispatchSessionCommand(sessionId, {
						_tag: "DeleteSession",
						deletedAt: yield* currentTimestamp,
					});
					yield* Effect.sync(() => state.clearSession(sessionId));
				}
				yield* dispatchChatCommand(
					chatId,
					{
						_tag: "DeleteChat",
						deletedAt: yield* currentTimestamp,
					},
					`${commandId}:delete`,
				);
				// ON DELETE CASCADE handles sessions + messages.
			});

		const handleChatDelete: ConversationReactorHandlers["chatDelete"] = (
			reactorInput,
		) =>
			Effect.gen(function* () {
				const deleteCommandId = `${reactorInput.commandId}:delete`;
				const completed = yield* sql<{ readonly command_id: string }>`
            SELECT command_id FROM command_receipts
            WHERE command_id = ${deleteCommandId}
            LIMIT 1
          `.pipe(Effect.orDie);
				if (completed.length > 0) return;
				yield* performChatDelete(
					ChatId.make(reactorInput.streamId),
					reactorInput.commandId,
				);
			});

		const reactorRuntime = yield* makeConversationReactorRuntime({
			providerStart: handleProviderStart,
			providerStop: handleProviderStop,
			autoName: handleAutoName,
			chatArchive: handleChatArchive,
			chatDelete: handleChatDelete,
		});
		runSessionReactors = reactorRuntime.runSession;
		runProviderStartReactor = reactorRuntime.runProviderStart;
		runProviderStopReactor = reactorRuntime.runProviderStop;
		runChatArchiveReactor = reactorRuntime.runChatArchive;
		runChatDeleteReactor = reactorRuntime.runChatDelete;
		yield* reactorRuntime.catchUpAll;

		const deleteChat: ConversationOperations["deleteChat"] = (chatId) =>
			Effect.gen(function* () {
				yield* lookupChat(chatId);
				yield* dispatchChatCommand(chatId, {
					_tag: "RequestDeleteChat",
					requestedAt: yield* currentTimestamp,
				});
				yield* runChatDeleteReactor;
			});

		const listMessages: ConversationOperations["listMessages"] = (sessionId) =>
			sessionQueries.messages(sessionId).pipe(
				Effect.map((records) => records.map(messageFromRecord)),
				Effect.catch((error) =>
					error._tag === "SessionQueryNotFound"
						? Effect.fail(new SessionNotFoundError({ sessionId }))
						: Effect.die(error),
				),
			);

		const goalOperations = makeConversationGoalOperations({
			provider,
			state: goalState,
			lookupSession,
			openProviderSession,
		});
		const { getGoal, setGoal, clearGoal, streamGoal } = goalOperations;

		const restartProviderSession = (
			session: Session,
			text: string,
			attachments: ReadonlyArray<AttachmentRef>,
		): Effect.Effect<void, SessionStartError> =>
			openProviderSession(session, { sendAfterOpen: { text, attachments } });

		const resumeSession: ConversationOperations["resumeSession"] = (
			sessionId,
		) =>
			Effect.gen(function* () {
				const session = yield* lookupSession(sessionId);
				if (session.resumeStrategy === "none" || session.cursor === null) {
					return yield* Effect.fail(
						new SessionStartError({
							providerId: session.providerId,
							reason: "resume_unsupported",
						}),
					);
				}
				// Best-effort cleanup of any stale in-memory session before opening
				// a fresh handle attached to the same DB row. Renderer subscriptions
				// stay connected across the
				// resume — only the event-pump fiber needs to restart.
				yield* closeProvider(sessionId);
				yield* interruptProviderFiber(sessionId);
				yield* openProviderSession(session, { postBootStatus: "running" });
				return yield* lookupSession(sessionId);
			});

		const submitUserMessage = (
			sessionId: SessionId,
			text: string,
			attachments?: ReadonlyArray<AttachmentRef>,
			fileRefs?: ReadonlyArray<FileRef>,
			skillRefs?: ReadonlyArray<SkillRef>,
			annotations?: ReadonlyArray<ComposerAnnotation>,
			asGoal?: boolean,
			clientMessageId?: MessageId,
			origin?: MessageOrigin,
		): Effect.Effect<boolean, SessionNotFoundError> =>
			Effect.gen(function* () {
				const session = yield* lookupSession(sessionId);
				if (asGoal !== true && isGoalCapableProvider(session.providerId)) {
					const goal = goalState.current(sessionId);
					const trimmed = text.trim();
					if (
						goal !== undefined &&
						goal !== null &&
						goal.status === "active" &&
						goal.objective.trim() === trimmed &&
						(yield* goalState.latestUserMessageMatches(sessionId, trimmed))
					) {
						return true;
					}
				}
				yield* beginTurn(sessionId);
				// Drop "pending-*" placeholder ids — those are renderer-side temp
				// tokens for attachments whose upload didn't finish before submit.
				// The bytes don't exist server-side, so forwarding them would just
				// make the driver log a 404 per attachment.
				const cleanAttachments = (attachments ?? []).filter(
					(a) => !a.id.startsWith("pending-"),
				);
				const annotationList = annotations ?? [];
				const hasRichSegments =
					cleanAttachments.length > 0 ||
					(fileRefs ?? []).length > 0 ||
					(skillRefs ?? []).length > 0 ||
					annotationList.length > 0;
				const content: MessageContent = hasRichSegments
					? {
							_tag: "user_rich",
							text,
							attachments: cleanAttachments,
							fileRefs: fileRefs ?? [],
							skillRefs: skillRefs ?? [],
							annotations: annotationList,
							...(origin !== undefined ? { origin } : {}),
							goal: asGoal === true,
						}
					: {
							_tag: "user",
							text,
							...(origin !== undefined ? { origin } : {}),
							goal: asGoal === true,
						};
				// Annotations have no native CLI token (unlike `@file` / `/skill`),
				// so the only place the model ever sees them is the prompt text.
				// Serialise them into a numbered list here — the single injection
				// point before `provider.send`, so every driver benefits. The
				// persisted `text` above stays clean; the structured `annotations`
				// array drives the rendered bubble.
				const sendText = [
					annotationList.length > 0
						? serializeAnnotations(annotationList)
						: null,
					text,
				]
					.filter((part): part is string => part !== null && part.length > 0)
					.join("\n\n")
					.trim();
				const persisted = yield* persistMessage(
					sessionId,
					content,
					clientMessageId,
				);
				// Pin the attachments so the GC sweep treats them as referenced —
				// a separate row per (message, attachment) keeps the existing
				// GC join intact.
				for (const a of cleanAttachments) {
					yield* sql`
            INSERT OR IGNORE INTO message_attachments (message_id, attachment_id)
            VALUES (${persisted.message.id}, ${a.id})
          `.pipe(Effect.ignore);
				}
				const chat = yield* lookupChat(session.chatId).pipe(
					Effect.mapError(() => new SessionNotFoundError({ sessionId })),
				);
				// Provisional title: update chat + session immediately for real tasks
				// so the sidebar/tab never sit on "New chat" while the LLM pass runs.
				const provisional = deriveProvisionalTitle(text);
				if (provisional !== "New chat") {
					if (session.title === "New chat") {
						yield* renameSession(sessionId, provisional);
					}
					if (chat.title === "New chat") {
						yield* renameChat(session.chatId, provisional).pipe(
							Effect.mapError(() => new SessionNotFoundError({ sessionId })),
						);
					}
				}
				if (asGoal === true) {
					const objective = text.trim();
					if (objective.length === 0) return false;
					if (!isGoalCapableProvider(session.providerId)) {
						const persistedError = yield* persistMessage(sessionId, {
							_tag: "error",
							message:
								"Goal mode is currently only supported for Codex and Grok sessions.",
						});
						yield* ndjsonAppend(sessionId, persistedError);
						return false;
					}
					const goal = yield* setGoal(sessionId, {
						objective,
						status: "active",
					}).pipe(
						Effect.catch((err) =>
							Effect.gen(function* () {
								const message =
									err._tag === "SessionStartError"
										? `Goal mode could not start ${session.providerId}: ${err.reason}`
										: `Goal mode could not start ${session.providerId} for this session.`;
								const persistedError = yield* persistMessage(sessionId, {
									_tag: "error",
									message,
								});
								yield* ndjsonAppend(sessionId, persistedError);
								yield* setStatus(sessionId, "idle");
								return null;
							}),
						),
					);
					if (goal === null) return false;
					// Grok runs goal mode by forwarding `/goal` as a real prompt turn,
					// so reflect the running turn the way a normal send does — the
					// driver emits `Status: idle` when the goal run finishes. Codex
					// drives its own status via native goal notifications, so leave it.
					if (session.providerId === "grok") {
						yield* setStatus(sessionId, "running");
					}
					return true;
				}
				// First attempt: push into the existing provider session. If that
				// session is gone (provider dropped it across an app restart) start
				// a fresh one under the same id, then push.
				console.log(
					`[conversation-services.sendMessage] sessionId=${sessionId} cleanAttachments=${cleanAttachments.length} (orig=${
						(attachments ?? []).length
					})`,
				);
				// If the session previously errored — typically an auth failure the
				// user has since fixed by signing in — the in-memory provider process
				// is stale: for Claude it was spawned without valid credentials and
				// won't re-read the keychain on its own. Drop it (mirrors setModel's
				// teardown) so the send below lazy-restarts a fresh process that picks
				// up the new login, instead of silently re-pushing into the dead one.
				const latestForSend = yield* lookupSession(sessionId).pipe(
					Effect.orDie,
				);
				if (latestForSend.status === "error") {
					yield* provider
						.close(sessionId)
						.pipe(Effect.catch(() => Effect.void));
					yield* interruptProviderFiber(sessionId);
				}
				const sendResult = yield* provider
					.send(sessionId, sendText, cleanAttachments, fileRefs, skillRefs)
					.pipe(
						Effect.matchEffect({
							onFailure: (err) =>
								Effect.succeed({
									_tag: "retry" as const,
									reason: formatProviderFailure(err),
								}),
							onSuccess: () => Effect.succeed("ok" as const),
						}),
					);
				if (sendResult !== "ok") {
					const isGrok = session.providerId === "grok";
					const looksLikeGrokAuthWorkerDeath =
						isGrok &&
						/Grok's agent worker rejected the session.*AuthorizationRequired/i.test(
							sendResult.reason,
						);

					if (looksLikeGrokAuthWorkerDeath) {
						yield* setStatus(sessionId, "running");
						return true;
					}

					// Auth failures aren't recoverable by restarting — re-spawning hits
					// the same 401, which is the infinite-retry / stuck-loading bug.
					// Persist the error so the renderer shows the "Sign in" CTA and stop.
					if (looksLikeAuthFailure(sendResult.reason)) {
						console.log(
							`[conversation-services.sendMessage] provider.send failed with auth error for ${sessionId}; skipping restart`,
						);
						const persistedError = yield* persistMessage(sessionId, {
							_tag: "error",
							message: sendResult.reason,
						});
						yield* ndjsonAppend(sessionId, persistedError);
						yield* setStatus(sessionId, "error");
						return false;
					}

					console.log(
						`[conversation-services.sendMessage] provider.send failed; restarting provider session for ${sessionId}`,
					);
					const restartResult = yield* restartProviderSession(
						session,
						sendText,
						cleanAttachments,
					).pipe(
						Effect.matchEffect({
							onFailure: (err) =>
								Effect.succeed({
									_tag: "failed" as const,
									reason: formatProviderFailure(err),
								}),
							onSuccess: () => Effect.succeed({ _tag: "ok" as const }),
						}),
					);
					if (restartResult._tag === "failed") {
						const message =
							`Provider restart failed after send could not find an active session.\n\n` +
							`Initial send failure:\n${sendResult.reason}\n\n` +
							`Restart failure:\n${restartResult.reason}`;
						const persistedError = yield* persistMessage(sessionId, {
							_tag: "error",
							message,
						});
						yield* ndjsonAppend(sessionId, persistedError);
						yield* setStatus(sessionId, "idle");
						return false;
					}
				}
				yield* setStatus(sessionId, "running");
				return true;
			});

		const sendMessage: ConversationOperations["sendMessage"] = (
			sessionId,
			text,
			attachments,
			fileRefs,
			skillRefs,
			annotations,
			asGoal,
			clientMessageId,
			origin,
		) =>
			Effect.gen(function* () {
				const accepted = yield* submitUserMessage(
					sessionId,
					text,
					attachments,
					fileRefs,
					skillRefs,
					annotations,
					asGoal,
					clientMessageId,
					origin,
				);
				if (!accepted) yield* settleActiveTurn(sessionId, "error");
			});

		const queueRuntime = yield* makeQueueServiceRuntime({
			sql,
			lookupSession,
			submitUserMessage: (sessionId, input) =>
				submitUserMessage(
					sessionId,
					input.text,
					input.attachments,
					input.fileRefs,
					input.skillRefs,
					input.annotations,
				),
			settleActiveTurn,
			setQueuePaused: (sessionId, paused) =>
				dispatchSessionCommand(sessionId, {
					_tag: "SetQueuePaused",
					paused,
					updatedAt: Date.now(),
				}),
		});
		flushQueueAfterIdle = queueRuntime.flushAfterIdle;
		shutdownQueueSession = queueRuntime.shutdown;

		const interruptSession: ConversationOperations["interruptSession"] = (
			sessionId,
		) =>
			Effect.gen(function* () {
				yield* lookupSession(sessionId);
				yield* provider
					.interrupt(sessionId)
					.pipe(Effect.mapError(() => new SessionNotFoundError({ sessionId })));
				yield* queueRuntime.pauseAfterInterrupt(sessionId);
				yield* settleActiveTurn(sessionId, "interrupted");
				yield* setStatus(sessionId, "idle");
			});

		const getSession: ConversationOperations["getSession"] = (sessionId) =>
			lookupSession(sessionId);

		const sessionService = {
			listSessions,
			getSession,
			createSession,
			renameSession,
			setModel,
			setProvider,
			setRuntimeMode,
			setPermissionMode,
			answerQuestion,
			setWorktree,
			archiveSession,
			unarchiveSession,
			deleteSession,
			resumeSession,
			getGoal,
			setGoal,
			clearGoal,
			streamGoal,
		} satisfies SessionServiceShape;
		const chatService = {
			listChats,
			getChat,
			createChat,
			renameChat,
			markChatRead,
			streamChatChanges,
			setChatWorktree,
			setChatActiveSession,
			archiveChat,
			unarchiveChat,
			deleteChat,
		} satisfies ChatServiceShape;
		const transcriptService = {
			continueExternalThread,
			importExternalMessages,
			forkSession,
			exportTranscript,
			latestPlan,
		} satisfies TranscriptServiceShape;
		const messageService = {
			listMessages,
			sendMessage,
			interruptSession,
		} satisfies MessageServiceShape;
		const queueService = queueRuntime.service;
		return Context.make(SessionService, sessionService).pipe(
			Context.add(ChatService, chatService),
			Context.add(TranscriptService, transcriptService),
			Context.add(MessageService, messageService),
			Context.add(QueueService, queueService),
		);
	}),
);
