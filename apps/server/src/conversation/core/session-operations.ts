import {
	AgentTurnId,
	type AttachmentRef,
	type Chat,
	type ChatId,
	DEFAULT_PERMISSION_MODE,
	DEFAULT_RUNTIME_MODE,
	type FolderId,
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
	type WorktreeId,
} from "@zuse/contracts";
import type { SessionCommand } from "@zuse/domain/core/commands";
import type { SessionDomainApi } from "@zuse/domain/engine/session-domain";
import type { SqlSessionQueriesApi } from "@zuse/domain/queries/sql-session-queries";
import { Effect, Schema, type Scope } from "effect";
import type { SqlClient } from "effect/unstable/sql";
import type {
	ConversationOperations,
	CreateSessionInput,
} from "../services/conversation-services.ts";
import { deriveProvisionalTitle } from "./conversation-input.ts";
import { type ChatRow, sessionFromRecord } from "./conversation-records.ts";
import type { PersistedMessage } from "./conversation-store-types.ts";
import {
	makeProviderSessionRuntime,
	type ProviderSessionRuntimeOptions,
} from "./provider-session-runtime.ts";

export interface SessionOperationsOptions
	extends Omit<
		ProviderSessionRuntimeOptions,
		"createSession" | "listSessions"
	> {
	readonly serviceScope: Scope.Scope;
	readonly sql: SqlClient.SqlClient;
	readonly sessionQueries: SqlSessionQueriesApi;
	readonly sessionDomain: SessionDomainApi;
	readonly currentTimestamp: Effect.Effect<number>;
	readonly broadcastChat: (chat: Chat) => Effect.Effect<void>;
	readonly persistMessage: (
		sessionId: SessionId,
		content: MessageContent,
		idOverride?: import("@zuse/contracts").MessageId,
		turnIdOverride?: AgentTurnId,
	) => Effect.Effect<PersistedMessage>;
	readonly runProviderStart: Effect.Effect<void, SessionStartError>;
	readonly dispatchSessionCommand: (
		sessionId: SessionId,
		command: SessionCommand,
	) => Effect.Effect<void>;
	readonly ndjsonAppend: (
		sessionId: SessionId,
		persisted: PersistedMessage,
	) => Effect.Effect<void>;
	readonly closeProvider: (sessionId: SessionId) => Effect.Effect<void>;
	readonly interruptProviderFiber: (
		sessionId: SessionId,
	) => Effect.Effect<void>;
	readonly teardownSubscription: (sessionId: SessionId) => Effect.Effect<void>;
}

export interface OpenProviderSessionOptions {
	readonly initialPrompt?: string;
	readonly modelOptions?: Readonly<Record<string, string>>;
	readonly enableSubagents?: boolean;
	readonly forkFromResume?: boolean;
	readonly postBootStatus?: Session["status"];
	readonly sendAfterOpen?: {
		readonly turnId: AgentTurnId;
		readonly text: string;
		readonly attachments: ReadonlyArray<AttachmentRef>;
		readonly fileRefs?: ReadonlyArray<import("@zuse/contracts").FileRef>;
		readonly skillRefs?: ReadonlyArray<import("@zuse/contracts").SkillRef>;
	};
}

const ProviderStartRequest = Schema.Struct({
	initialPrompt: Schema.NullOr(Schema.String),
	initialTurnId: Schema.optional(Schema.NullOr(AgentTurnId)),
	modelOptionsJson: Schema.NullOr(Schema.String),
	enableSubagents: Schema.Boolean,
	forkFromResume: Schema.Boolean,
	background: Schema.Boolean,
	postBootStatus: Schema.Literals(["idle", "running"]),
});
type ProviderStartRequest = typeof ProviderStartRequest.Type;

export const makeSessionOperations = (options: SessionOperationsOptions) => {
	const {
		serviceScope,
		sql,
		state,
		sessionQueries,
		sessionDomain,
		provider,
		currentTimestamp,
		agentsFor,
		cwdForWorktree,
		runtime,
		configStore,
		worktrees,
		createChat,
		getChat: lookupChat,
		getSession: lookupSession,
		sendMessage,
		listMessages,
		listChats,
		attachProvider,
		setStatus,
		startSubscription,
		linearTools,
		broadcastChat,
		persistMessage,
		runProviderStart,
		dispatchSessionCommand,
		ndjsonAppend,
		closeProvider,
		interruptProviderFiber,
		teardownSubscription,
	} = options;
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

	const { openProviderSession } = makeProviderSessionRuntime({
		state,
		agentsFor,
		cwdForWorktree,
		runtime,
		configStore,
		worktrees,
		createChat,
		createSession: (input) => Effect.suspend(() => createSession(input)),
		getChat: lookupChat,
		getSession: lookupSession,
		sendMessage,
		listMessages,
		listChats,
		listSessions,
		provider,
		attachProvider,
		setStatus,
		startSubscription,
		linearTools,
	});

	const createSession: ConversationOperations["createSession"] = (
		input: CreateSessionInput,
	) => {
		const sessionId =
			input.sessionId ?? SessionId.make(`s_${crypto.randomUUID()}`);
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
			if (input.agents !== undefined && Object.keys(input.agents).length > 0) {
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
			const initialTurnId = hasInitial
				? AgentTurnId.make(`turn_${crypto.randomUUID()}`)
				: null;
			const initialMessageId = hasInitial
				? MessageId.make(crypto.randomUUID())
				: null;
			const resumeCursor = input.resumeCursor ?? null;
			const resumeStrategy: ResumeStrategy =
				resumeCursor === null ? "none" : (input.resumeStrategy ?? "none");
			const forkedFromSessionId = input.forkedFromSessionId ?? null;
			const forkedFromMessageId = input.forkedFromMessageId ?? null;
			// Only fork the transcript when we actually have a cursor to fork.
			const forkFromResume =
				input.forkFromResume === true && resumeCursor !== null;
			const postBootStatus: Session["status"] = hasInitial ? "running" : "idle";
			const providerStart: ProviderStartRequest = {
				initialPrompt: promptForProvider ?? null,
				initialTurnId,
				modelOptionsJson:
					input.modelOptions === undefined
						? null
						: JSON.stringify(input.modelOptions),
				enableSubagents: effectiveEnableSubagents,
				forkFromResume,
				background: true,
				postBootStatus,
			};
			// Creation acknowledges the durable session/turn/provider intent,
			// never the provider side effect. The reactor owns the transition
			// from booting to the requested post-boot status.
			const rowStatus: Session["status"] = "booting";
			const createSessionRecord = sessionDomain
				.dispatch({
					commandId: `session:create:${sessionId}`,
					streamId: sessionId,
					command: {
						_tag: hasInitial ? "CreateSessionWithInitialTurn" : "CreateSession",
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
						...(hasInitial &&
						initialTurnId !== null &&
						initialMessageId !== null
							? {
									turnId: initialTurnId,
									messageId: initialMessageId,
									messageContentJson: JSON.stringify({
										_tag: "user",
										text: input.initialPrompt ?? "",
										goal: false,
										...(origin !== undefined ? { origin } : {}),
									}),
								}
							: {}),
						createdAt: now.getTime(),
					} as SessionCommand,
				})
				.pipe(Effect.orDie);
			yield* createSessionRecord;
			yield* lookupChat(input.chatId).pipe(
				Effect.flatMap(broadcastChat),
				Effect.catch(() => Effect.void),
			);
			if (initialTurnId !== null) {
				state.rememberActiveTurn(sessionId, initialTurnId);
			}
			// Provider startup is service-owned. Request/RPC cancellation cannot
			// cancel it or turn normal scope cleanup into a failed chat receipt.
			yield* Effect.forkIn(
				runProviderStart.pipe(
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

	const respondToPlan: ConversationOperations["respondToPlan"] = (
		sessionId,
		toolCallId,
		outcome,
		feedback,
	) =>
		Effect.gen(function* () {
			yield* lookupSession(sessionId);
			const settleUnavailableInteraction = Effect.gen(function* () {
				const persisted = yield* persistMessage(sessionId, {
					_tag: "tool_result",
					itemId: toolCallId,
					output: {
						outcome,
						reason: "provider_session_unavailable",
						...(feedback === undefined ? {} : { feedback }),
					},
					isError: true,
				});
				yield* ndjsonAppend(sessionId, persisted);
				return yield* Effect.fail(new SessionNotFoundError({ sessionId }));
			});
			const respond = provider.respondToPlan;
			if (respond === undefined) {
				return yield* settleUnavailableInteraction;
			}
			yield* respond(sessionId, toolCallId, outcome, feedback).pipe(
				Effect.catchTag(
					"AgentSessionNotFoundError",
					() => settleUnavailableInteraction,
				),
			);
			const persisted = yield* persistMessage(sessionId, {
				_tag: "tool_result",
				itemId: toolCallId,
				output: {
					outcome,
					...(feedback === undefined ? {} : { feedback }),
				},
				isError: false,
			});
			yield* ndjsonAppend(sessionId, persisted);
		});

	const updateMcpServers: ConversationOperations["updateMcpServers"] = (
		sessionId,
		servers,
	) =>
		Effect.gen(function* () {
			yield* lookupSession(sessionId);
			const update = provider.updateMcpServers;
			if (update === undefined) return;
			yield* update(sessionId, servers).pipe(
				Effect.catchTag("AgentSessionNotFoundError", () =>
					Effect.fail(new SessionNotFoundError({ sessionId })),
				),
			);
		});

	const ensureSessionNotStarted = (sessionId: SessionId) =>
		sql<{ readonly id: string }>`
      SELECT id FROM messages
      WHERE session_id = ${sessionId} AND role = 'user'
      LIMIT 1
    `.pipe(
			Effect.orDie,
			Effect.filterOrFail(
				(rows) => rows.length === 0,
				() => new SessionAlreadyStartedError({ sessionId }),
			),
			Effect.asVoid,
		);

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
			yield* ensureSessionNotStarted(sessionId);
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
			yield* ensureSessionNotStarted(sessionId);
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

	const deleteSession: ConversationOperations["deleteSession"] = (sessionId) =>
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

	return {
		listSessions,
		openProviderSession,
		createSession,
		renameSession,
		setRuntimeMode,
		setPermissionMode,
		answerQuestion,
		respondToPlan,
		updateMcpServers,
		setWorktree,
		setModel,
		setProvider,
		archiveSession,
		unarchiveSession,
		deleteSession,
	};
};
