import {
	type AgentItemId,
	AgentTurnId,
	type Chat,
	type ChatId,
	DEFAULT_PERMISSION_MODE,
	DEFAULT_RUNTIME_MODE,
	type FolderId,
	type MessageContent,
	MessageId,
	type MessageOrigin,
	PlanResolutionError,
	type ProviderId,
	ProviderThreadId,
	providerCapabilities,
	QuestionResolutionError,
	Session,
	SessionAlreadyStartedError,
	SessionConfigurationError,
	SessionId,
	SessionModeUnsupportedError,
	SessionNotFoundError,
	SessionStartError,
	type WorktreeId,
} from "@zuse/contracts";
import { ownsInputRequest } from "@zuse/domain/agent-engine/input-owner";
import type { SessionCommand } from "@zuse/domain/core/commands";
import { providerThreadIdFor } from "@zuse/domain/core/state";
import type { CommandReceipt } from "@zuse/domain/engine/dispatch";
import type { SessionDomainApi } from "@zuse/domain/engine/session-domain";
import type { SqlSessionQueriesApi } from "@zuse/domain/queries/sql-session-queries";
import { KeyedEffectSerialWorker } from "@zuse/utils/keyed-worker";
import { structuralTupleKey } from "@zuse/utils/structural-tuple-key";
import { Effect, Schema, type Scope } from "effect";
import type { SqlClient } from "effect/unstable/sql";
import { cancelSessionAutomation } from "../../automation/service.ts";
import type {
	ConversationOperations,
	CreateSessionInput,
} from "../services/conversation-services.ts";
import { makeContextHandoff } from "./context-handoff.ts";
import { type ChatRow, sessionFromRecord } from "./conversation-records.ts";
import type { PersistedMessage } from "./conversation-store-types.ts";
import { validateDelegationOrigin } from "./delegation-origin.ts";
import { makeOrchestrationTaskRuntime } from "./orchestration-task-runtime.ts";
import { makePlanDelivery } from "./plan-delivery.ts";
import { makePlanExpiry } from "./plan-expiry.ts";
import { PlanResponse, readPlanResponse } from "./plan-response.ts";
import { makeProviderContexts } from "./provider-contexts.ts";
import {
	makeProviderSessionRuntime,
	type ProviderSessionRuntimeOptions,
} from "./provider-session-runtime.ts";
import type { ProviderStartRequest } from "./provider-turn-request.ts";
import { loadQuestionAuthority } from "./question-authority.ts";
import {
	makeQuestionAnswerDeliveryPayload,
	parseQuestionAnswerDeliveryPayload,
	questionAnswerMessageId,
	questionCancellationCommandId,
} from "./question-delivery.ts";
import {
	lookupDurableQuestionResolution,
	settleDurableQuestionResolution,
} from "./question-resolution-receipt.ts";

const questionResolutionError = (sessionId: SessionId, itemId: AgentItemId) =>
	new QuestionResolutionError({
		sessionId,
		itemId,
		reason:
			"The question could not be resolved. It may have expired, or an earlier response may already be recorded.",
	});

export interface SessionOperationsOptions
	extends Omit<
		ProviderSessionRuntimeOptions,
		"createSession" | "listSessions"
	> {
	readonly setStatus: (
		sessionId: SessionId,
		status: Session["status"],
	) => Effect.Effect<void>;
	readonly serviceScope: Scope.Scope;
	readonly sql: SqlClient.SqlClient;
	readonly sessionQueries: SqlSessionQueriesApi;
	readonly sessionDomain: SessionDomainApi;
	readonly currentTimestamp: Effect.Effect<number>;
	readonly broadcastChat: (chat: Chat) => Effect.Effect<void>;
	readonly persistProviderMessage: import("./conversation-store-runtime.ts").ConversationStoreRuntime["persistProviderMessage"];
	readonly persistMessage: (
		sessionId: SessionId,
		content: MessageContent,
		idOverride?: import("@zuse/contracts").MessageId,
		turnIdOverride?: AgentTurnId | null,
	) => Effect.Effect<PersistedMessage>;
	readonly runSessionReactors: (sessionId: SessionId) => Effect.Effect<void>;
	readonly dispatchSessionCommand: (
		sessionId: SessionId,
		command: SessionCommand,
	) => Effect.Effect<void>;
	readonly dispatchSessionCommandWithId: (
		sessionId: SessionId,
		commandId: string,
		command: SessionCommand,
	) => Effect.Effect<CommandReceipt>;
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
		modelCatalog,
		worktrees,
		createChat,
		getChat: lookupChat,
		getSession: lookupSession,
		sendMessage,
		listMessages,
		listChats,
		setStatus,
		startSubscription,
		broadcastChat,
		persistMessage,
		persistProviderMessage,
		runSessionReactors,
		dispatchSessionCommand,
		dispatchSessionCommandWithId,
		ndjsonAppend,
		closeProvider,
		interruptProviderFiber,
		teardownSubscription,
	} = options;
	const inputResolutionWorker = new KeyedEffectSerialWorker<string>();
	const listSessions: ConversationOperations["listSessions"] = (
		projectId,
		includeArchived,
	) =>
		sessionQueries.list({ projectId, includeArchived }).pipe(
			Effect.map((records) => records.map(sessionFromRecord)),
			Effect.orDie,
		);

	const lookupChatForSession = (
		chatId: ChatId,
		providerId: ProviderId,
	): Effect.Effect<ChatRow, SessionStartError> =>
		Effect.gen(function* () {
			const rows = yield* sql<ChatRow>`
          SELECT id, project_id, worktree_id, title, title_provenance, active_session_id, origin_session_id,
                 archived_at, archived_worktree_json, last_message_at, last_user_message_at, last_read_at, created_at, updated_at
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

	const { ensureForTurn } = makeProviderSessionRuntime({
		awaitWorkspaceReady: options.awaitWorkspaceReady,
		sessionQueries,
		tasks: makeOrchestrationTaskRuntime(sql, sessionDomain, (id) =>
			cancelSessionAutomation(sql, SessionId.make(id)),
		),
		interruptSession: options.interruptSession,
		addQueuedMessage: options.addQueuedMessage,
		runQueuedMessageNext: options.runQueuedMessageNext,
		state,
		sessionDomain,
		agentsFor,
		cwdForWorktree,
		runtime,
		configStore,
		modelCatalog,
		worktrees,
		createChat,
		createSession: (input) => Effect.suspend(() => createSession(input)),
		getChat: lookupChat,
		getSession: lookupSession,
		sendMessage,
		waitSession: options.waitSession,
		sendMessageAndWait: options.sendMessageAndWait,
		listMessages,
		listChats,
		listSessions,
		persistProviderMessage,
		provider,
		startSubscription,
	});

	const createSession: ConversationOperations["createSession"] = (
		input: CreateSessionInput,
	) => {
		const sessionId =
			input.sessionId ?? SessionId.make(`s_${crypto.randomUUID()}`);
		return Effect.gen(function* () {
			const chatRow = yield* lookupChatForSession(
				input.chatId,
				input.providerId,
			);
			const projectId = chatRow.project_id as FolderId;
			const worktreeId: WorktreeId | null =
				chatRow.worktree_id === null
					? null
					: (chatRow.worktree_id as unknown as WorktreeId);

			const effectiveEnableSubagents =
				input.enableSubagents ??
				(providerCapabilities(input.providerId).nativeSubagentsByDefault ||
					(input.agents !== undefined && Object.keys(input.agents).length > 0));
			const initialPermissionMode =
				input.permissionMode ?? DEFAULT_PERMISSION_MODE;
			const initialToolSearch = input.toolSearch ?? false;
			const initialRuntimeMode = input.runtimeMode ?? DEFAULT_RUNTIME_MODE;
			state.setRuntimeMode(sessionId, initialRuntimeMode);
			if (input.agents !== undefined || input.enableSubagents !== undefined) {
				state.setAgents(sessionId, {
					agents: input.agents ?? {},
					enableSubagents: effectiveEnableSubagents,
				});
			}
			const now = new Date();
			const title = input.title?.trim() || "New chat";
			const agentsJson =
				input.agents !== undefined || input.enableSubagents !== undefined
					? JSON.stringify({
							agents: input.agents ?? {},
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
			let origin: MessageOrigin | undefined = input.origin;
			const originSessionId =
				input.originSessionId ?? chatRow.origin_session_id;
			if (hasInitial && !origin && originSessionId !== null) {
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
			const initialTurnId = hasInitial
				? (input.initialTurnId ??
					AgentTurnId.make(`turn_${crypto.randomUUID()}`))
				: null;
			const initialMessageId = hasInitial
				? (input.initialMessageId ?? MessageId.make(crypto.randomUUID()))
				: null;
			const providerThreadSeed =
				input.providerThread === undefined
					? undefined
					: {
							provider: input.providerId,
							nativeThreadId: input.providerThread.nativeThreadId,
							nativeHeadId: input.providerThread.nativeHeadId ?? null,
						};
			const forkedFromSessionId = input.forkedFromSessionId ?? null;
			const forkedFromMessageId = input.forkedFromMessageId ?? null;

			const forkFromResume =
				input.forkFromResume === true && providerThreadSeed !== undefined;
			const postBootStatus: Session["status"] = hasInitial ? "running" : "idle";
			const providerStart: ProviderStartRequest = {
				initialPrompt: null,
				initialTurnId: null,
				modelOptionsJson:
					input.modelOptions === undefined
						? null
						: JSON.stringify(input.modelOptions),
				enableSubagents: effectiveEnableSubagents,
				forkFromResume,
				forkSourceThreadId: forkFromResume
					? providerThreadSeed?.nativeThreadId
					: undefined,
				background: true,
				postBootStatus,
			};

			const rowStatus: Session["status"] = hasInitial ? "booting" : "idle";
			if (input.delegation !== undefined && initialTurnId === null)
				return yield* new SessionStartError({
					providerId: input.providerId,
					reason: "Delegated work requires an initial task.",
				});
			const createSessionRecord = sessionDomain
				.dispatchTransactionally(
					{
						commandId: input.commandId ?? `session:create:${sessionId}`,
						streamId: sessionId,
						command: {
							_tag: hasInitial
								? "CreateSessionWithInitialTurn"
								: "CreateSession",
							sessionId,
							...(input.delegation === undefined || initialTurnId === null
								? {}
								: {
										delegation: {
											...input.delegation,
											childTurnId: initialTurnId,
										},
									}),
							chatId: input.chatId,
							projectId,
							title,
							titleProvenance: input.title?.trim() ? "manual" : "pending",
							providerId: input.providerId,
							model: input.model,
							status: rowStatus,
							runtimeMode: initialRuntimeMode,
							agentsJson,
							worktreeId,
							forkedFromSessionId,
							forkedFromMessageId,
							permissionMode: initialPermissionMode,
							toolSearch: initialToolSearch,
							queuePaused: input.queuePaused ?? false,
							providerStartJson: JSON.stringify(providerStart),
							...(providerThreadSeed === undefined
								? {}
								: { providerThread: providerThreadSeed }),
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
										providerInputJson: JSON.stringify({
											actor: input.actor,
											githubSlackMessageId: input.githubSlackMessageId,
											text: input.initialPrompt ?? "",
											attachments: [],
											fileRefs: [],
											skillRefs: [],
											annotations: [],
										}),
									}
								: {}),
							createdAt: now.getTime(),
						} as SessionCommand,
					},
					(receipt) =>
						input.delegation === undefined
							? Effect.succeed(receipt)
							: validateDelegationOrigin(
									sql,
									input.delegation,
									sessionId,
									input.providerId,
								).pipe(Effect.as(receipt)),
				)
				.pipe(
					Effect.catch((error) =>
						error._tag === "SessionStartError"
							? Effect.fail(error)
							: Effect.die(error),
					),
				);
			yield* createSessionRecord;
			yield* lookupChat(input.chatId).pipe(
				Effect.flatMap(broadcastChat),
				Effect.catch(() => Effect.void),
			);
			if (initialTurnId !== null) {
				state.rememberActiveTurn(sessionId, initialTurnId);
				yield* Effect.forkIn(
					runSessionReactors(sessionId).pipe(
						Effect.catchCause((cause) =>
							Effect.logWarning(
								`[ConversationServices] initial turn reactor failed: ${String(cause)}`,
							),
						),
					),
					serviceScope,
					{ startImmediately: true },
				);
			}
			return Session.make({
				id: sessionId,
				parentSessionId: input.delegation?.parentSessionId
					? SessionId.make(input.delegation.parentSessionId)
					: null,
				projectId,
				title,
				providerId: input.providerId,
				model: input.model,
				status: rowStatus,
				archivedAt: null,
				providerThread:
					providerThreadSeed === undefined
						? null
						: {
								id: ProviderThreadId.make(
									providerThreadIdFor(
										sessionId,
										providerThreadSeed.provider,
										providerThreadSeed.nativeThreadId,
									),
								),
								provider: input.providerId,
								nativeThreadRef: {
									provider: input.providerId,
									nativeId: providerThreadSeed.nativeThreadId,
									strength: "strong",
								},
								nativeHeadRef:
									providerThreadSeed.nativeHeadId === null
										? null
										: {
												provider: input.providerId,
												nativeId: providerThreadSeed.nativeHeadId,
												strength: "weak",
											},
								status: "not_loaded",
								firstTurnOrdinal: null,
								lastTurnOrdinal: null,
								createdAt: now,
								updatedAt: now,
							},
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
		commandId,
	) =>
		Effect.gen(function* () {
			yield* lookupSession(sessionId);
			yield* dispatchSessionCommandWithId(sessionId, commandId, {
				_tag: "SetTitle",
				title,
				titleProvenance: "manual",
				updatedAt: yield* currentTimestamp,
			});
			return yield* lookupSession(sessionId);
		});

	/**
	 * Retire the old provider before publishing access changes. Native SDK modes
	 * can bypass callbacks entirely, so changing only the cached policy is unsafe.
	 * The next turn resumes the same conversation with the new native posture.
	 */
	const setRuntimeMode: ConversationOperations["setRuntimeMode"] = (
		sessionId,
		runtimeMode,
		commandId,
	) =>
		Effect.gen(function* () {
			const session = yield* lookupSession(sessionId);
			if (session.providerId === "pi")
				return yield* new SessionModeUnsupportedError({
					message:
						"Pi manages permissions natively; Zuse permission modes are unsupported.",
				});
			const changed = session.runtimeMode !== runtimeMode;
			if (changed) {
				yield* closeProvider(sessionId);

				yield* provider.close(sessionId).pipe(Effect.catch(() => Effect.void));
				yield* interruptProviderFiber(sessionId);
			}
			yield* dispatchSessionCommandWithId(sessionId, commandId, {
				_tag: "SetRuntimeMode",
				runtimeMode,
				updatedAt: yield* currentTimestamp,
			});
			state.setRuntimeMode(sessionId, runtimeMode);
			if (changed) yield* setStatus(sessionId, "idle");
		});

	const setPermissionMode: ConversationOperations["setPermissionMode"] = (
		sessionId,
		mode,
		commandId,
	) =>
		Effect.gen(function* () {
			const session = yield* lookupSession(sessionId);
			if (session.providerId === "pi")
				return yield* new SessionModeUnsupportedError({
					message:
						"Pi manages permissions natively; Zuse permission modes are unsupported.",
				});
			yield* dispatchSessionCommandWithId(sessionId, commandId, {
				_tag: "SetPermissionMode",
				permissionMode: mode,
				updatedAt: yield* currentTimestamp,
			});
			yield* provider
				.setPermissionMode(sessionId, mode)
				.pipe(Effect.catch(() => Effect.void));
		});

	const answerQuestion: ConversationOperations["answerQuestion"] = (
		sessionId,
		itemId,
		answers,
	) =>
		inputResolutionWorker.run(
			structuralTupleKey(sessionId, itemId),
			Effect.gen(function* () {
				yield* lookupSession(sessionId);
				const requestedDelivery = makeQuestionAnswerDeliveryPayload(answers);
				const answerMessageId = questionAnswerMessageId(sessionId, itemId);
				const receipt = yield* lookupDurableQuestionResolution(
					sql,
					sessionId,
					itemId,
				);
				if (receipt._tag === "answer") {
					const conflicts =
						receipt.delivery.answerKey !== requestedDelivery.answerKey;
					yield* settleDurableQuestionResolution(
						sql,
						provider,
						sessionId,
						itemId,
						receipt,
					).pipe(
						Effect.mapError(() => questionResolutionError(sessionId, itemId)),
					);
					if (conflicts) {
						return yield* Effect.fail(
							questionResolutionError(sessionId, itemId),
						);
					}
					return;
				}
				if (receipt._tag === "cancel") {
					yield* settleDurableQuestionResolution(
						sql,
						provider,
						sessionId,
						itemId,
						receipt,
					).pipe(
						Effect.mapError(() => questionResolutionError(sessionId, itemId)),
					);
					return yield* Effect.fail(questionResolutionError(sessionId, itemId));
				}
				if (receipt._tag === "invalid") {
					return yield* Effect.fail(questionResolutionError(sessionId, itemId));
				}
				const authority = yield* loadQuestionAuthority(
					sql,
					sessionId,
					itemId,
				).pipe(Effect.orDie);
				if (authority === null)
					return yield* Effect.fail(questionResolutionError(sessionId, itemId));
				yield* provider
					.validateQuestionAnswer(sessionId, itemId, answers)
					.pipe(
						Effect.mapError(() => questionResolutionError(sessionId, itemId)),
					);

				const rows = yield* sql<{
					readonly action: "answer" | "cancel";
					readonly answers_json: string | null;
				}>`
					SELECT action, answers_json
				FROM question_answer_deliveries
				WHERE session_id = ${sessionId} AND item_id = ${itemId}
				LIMIT 1
			`.pipe(Effect.orDie);
				let delivery = rows[0];
				if (delivery === undefined) {
					if (!(yield* provider.hasQuestionAttachment(sessionId, itemId))) {
						return yield* Effect.fail(
							questionResolutionError(sessionId, itemId),
						);
					}
					const now = yield* currentTimestamp;
					yield* sql`
						INSERT INTO question_answer_deliveries (
							session_id, item_id, action, answers_json, created_at, updated_at
						) VALUES (
							${sessionId}, ${itemId}, 'answer', ${requestedDelivery.answersJson}, ${now}, ${now}
						)
					`.pipe(Effect.orDie);
					delivery = {
						action: "answer",
						answers_json: requestedDelivery.answersJson,
					};
				}
				if (delivery.action !== "answer" || delivery.answers_json === null) {
					return yield* Effect.fail(questionResolutionError(sessionId, itemId));
				}
				const durableDelivery = parseQuestionAnswerDeliveryPayload(
					delivery.answers_json,
				);
				if (
					durableDelivery === null ||
					durableDelivery.answerKey !== requestedDelivery.answerKey
				) {
					return yield* Effect.fail(questionResolutionError(sessionId, itemId));
				}

				const persistReceipt = Effect.gen(function* () {
					const persisted = yield* persistMessage(
						sessionId,
						{
							_tag: "user_question_answer",
							itemId,
							answers: durableDelivery.answers,
						},
						answerMessageId,
						authority.turnId,
					);
					if (persisted.changed) yield* ndjsonAppend(sessionId, persisted);
				});
				if (!(yield* provider.hasQuestionAttachment(sessionId, itemId))) {
					return yield* Effect.fail(questionResolutionError(sessionId, itemId));
				}

				if (
					!(yield* ownsInputRequest(sql, sessionId, authority.owner).pipe(
						Effect.orDie,
					))
				)
					return yield* Effect.fail(questionResolutionError(sessionId, itemId));

				yield* provider
					.answerQuestion(sessionId, itemId, durableDelivery.answers)
					.pipe(
						Effect.mapError(() => questionResolutionError(sessionId, itemId)),
					);

				yield* persistReceipt;
				yield* sql`
				DELETE FROM question_answer_deliveries
				WHERE session_id = ${sessionId} AND item_id = ${itemId}
			`.pipe(Effect.orDie);
				yield* provider.acknowledgeQuestionResolution(sessionId, itemId);
			}),
		);

	const cancelQuestion: ConversationOperations["cancelQuestion"] = (
		sessionId,
		itemId,
	) =>
		inputResolutionWorker.run(
			structuralTupleKey(sessionId, itemId),
			Effect.gen(function* () {
				yield* lookupSession(sessionId);
				const receipt = yield* lookupDurableQuestionResolution(
					sql,
					sessionId,
					itemId,
				);
				if (receipt._tag === "answer" || receipt._tag === "cancel") {
					yield* settleDurableQuestionResolution(
						sql,
						provider,
						sessionId,
						itemId,
						receipt,
					).pipe(
						Effect.mapError(() => questionResolutionError(sessionId, itemId)),
					);
					if (receipt._tag === "answer") {
						return yield* Effect.fail(
							questionResolutionError(sessionId, itemId),
						);
					}
					return;
				}
				if (receipt._tag === "invalid") {
					return yield* Effect.fail(questionResolutionError(sessionId, itemId));
				}
				const expired =
					yield* sql`SELECT 1 FROM session_inputs WHERE session_id = ${sessionId}
					AND kind = 'question' AND request_id = ${itemId} AND status = 'expired'`.pipe(
						Effect.orDie,
					);
				if (expired.length > 0) {
					yield* dispatchSessionCommandWithId(
						sessionId,
						questionCancellationCommandId(sessionId, itemId),
						{
							_tag: "ResolveQuestion",
							itemId,
							resolution: "cancelled",
							resolvedAt: yield* currentTimestamp,
						},
					);
					yield* sql`DELETE FROM question_answer_deliveries WHERE session_id = ${sessionId} AND item_id = ${itemId}`.pipe(
						Effect.orDie,
					);
					return;
				}

				const authority = yield* loadQuestionAuthority(
					sql,
					sessionId,
					itemId,
				).pipe(Effect.orDie);
				if (authority === null)
					return yield* Effect.fail(questionResolutionError(sessionId, itemId));

				const persistCancellation = Effect.gen(function* () {
					return yield* dispatchSessionCommandWithId(
						sessionId,
						questionCancellationCommandId(sessionId, itemId),
						{
							_tag: "ResolveQuestion",
							itemId,
							resolution: "cancelled",
							resolvedAt: yield* currentTimestamp,
						},
					);
				});

				const rows = yield* sql<{
					readonly action: "answer" | "cancel";
					readonly answers_json: string | null;
				}>`
					SELECT action, answers_json
					FROM question_answer_deliveries
					WHERE session_id = ${sessionId} AND item_id = ${itemId}
					LIMIT 1
				`.pipe(Effect.orDie);
				const existing = rows[0];
				if (
					existing !== undefined &&
					(existing.action !== "cancel" || existing.answers_json !== null)
				) {
					return yield* Effect.fail(questionResolutionError(sessionId, itemId));
				}
				if (!(yield* provider.hasQuestionAttachment(sessionId, itemId))) {
					const questions = yield* sql<{ readonly found: number }>`
						SELECT 1 AS found FROM messages
						WHERE session_id = ${sessionId}
						  AND kind = 'user_question'
						  AND json_valid(content_json)
						  AND json_extract(content_json, '$.itemId') = ${itemId}
						LIMIT 1
					`.pipe(Effect.orDie);
					if (questions.length === 0) {
						return yield* Effect.fail(
							questionResolutionError(sessionId, itemId),
						);
					}
					yield* persistCancellation;
					return yield* settleDurableQuestionResolution(
						sql,
						provider,
						sessionId,
						itemId,
						{ _tag: "cancel" },
					).pipe(
						Effect.mapError(() => questionResolutionError(sessionId, itemId)),
					);
				}
				if (existing === undefined) {
					const now = yield* currentTimestamp;
					yield* sql`
						INSERT INTO question_answer_deliveries (
							session_id, item_id, action, answers_json, created_at, updated_at
						) VALUES (${sessionId}, ${itemId}, 'cancel', NULL, ${now}, ${now})
					`.pipe(Effect.orDie);
				}

				if (!(yield* provider.hasQuestionAttachment(sessionId, itemId))) {
					return yield* Effect.fail(questionResolutionError(sessionId, itemId));
				}
				if (
					!(yield* ownsInputRequest(sql, sessionId, authority.owner).pipe(
						Effect.orDie,
					))
				)
					return yield* Effect.fail(questionResolutionError(sessionId, itemId));

				yield* provider
					.cancelQuestion(sessionId, itemId)
					.pipe(
						Effect.mapError(() => questionResolutionError(sessionId, itemId)),
					);
				yield* persistCancellation;
				yield* sql`
					DELETE FROM question_answer_deliveries
					WHERE session_id = ${sessionId} AND item_id = ${itemId}
				`.pipe(Effect.orDie);
				yield* provider.acknowledgeQuestionResolution(sessionId, itemId);
			}),
		);

	const planDelivery = makePlanDelivery(sql, options);
	const respondToPlan: ConversationOperations["respondToPlan"] = (
		sessionId,
		toolCallId,
		outcome,
		feedback,
	) =>
		inputResolutionWorker.run(
			structuralTupleKey("plan", sessionId, toolCallId),
			Effect.gen(function* () {
				yield* lookupSession(sessionId);
				const unavailable = () =>
					new PlanResolutionError({
						sessionId,
						itemId: toolCallId,
						reason:
							"This plan decision is unavailable or conflicts with an accepted response.",
					});
				const existing = yield* readPlanResponse(
					sql,
					sessionId,
					toolCallId,
				).pipe(Effect.orDie);
				if (existing._tag === "resolved") {
					if (
						existing.response.outcome !== outcome ||
						existing.response.feedback !== feedback
					)
						return yield* unavailable();
					yield* provider.acknowledgePlanResponse?.(sessionId, toolCallId) ??
						Effect.void;
					return;
				}
				const delivery = yield* planDelivery.read(sessionId, toolCallId);
				if (delivery !== undefined) {
					const response = yield* Schema.decodeUnknownEffect(
						Schema.fromJsonString(PlanResponse),
					)(delivery.response_json).pipe(Effect.mapError(unavailable));
					if (
						response.outcome !== outcome ||
						response.feedback !== feedback ||
						delivery.status === "uncertain"
					)
						return yield* unavailable();
					if (
						delivery.status === "accepted" ||
						delivery.status === "committed"
					) {
						yield* planDelivery.commit(delivery);
						yield* provider.acknowledgePlanResponse?.(sessionId, toolCallId) ??
							Effect.void;
						return;
					}
				}
				if (
					existing._tag !== "pending" ||
					!(yield* ownsInputRequest(sql, sessionId, existing.owner).pipe(
						Effect.orDie,
					))
				)
					return yield* unavailable();
				const respond = provider.respondToPlan;
				if (respond === undefined) return yield* unavailable();
				yield* planDelivery.begin(
					sessionId,
					toolCallId,
					existing.turnId,
					existing.owner,
					{ outcome, ...(feedback === undefined ? {} : { feedback }) },
				);
				yield* respond(sessionId, toolCallId, outcome, feedback).pipe(
					Effect.tapError(() => planDelivery.uncertain(sessionId, toolCallId)),
					Effect.mapError(unavailable),
				);
				yield* planDelivery.accepted(sessionId, toolCallId);
				const accepted = yield* planDelivery.read(sessionId, toolCallId);
				if (accepted === undefined) return yield* unavailable();
				yield* planDelivery.commit(accepted);
				yield* provider.acknowledgePlanResponse?.(sessionId, toolCallId) ??
					Effect.void;
			}),
		);

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

	const handoffs = makeContextHandoff(sql);
	const providerContexts = makeProviderContexts(sql);
	const configureProvider = (
		sessionId: SessionId,
		command: Extract<SessionCommand, { _tag: "SetProvider" | "SetModel" }>,
	) =>
		Effect.gen(function* () {
			const previous = yield* lookupSession(sessionId);
			const resume =
				command._tag === "SetProvider"
					? yield* providerContexts
							.returning(sessionId, command.providerId as ProviderId)
							.pipe(Effect.orDie)
					: null;
			const selectedCommand =
				command._tag === "SetProvider"
					? {
							...command,
							expectedProviderThreadId: previous.providerThread?.id ?? null,
							resumeThreadId: resume?.threadId,
						}
					: command;
			return yield* sessionDomain
				.dispatchTransactionally(
					{
						commandId: crypto.randomUUID(),
						streamId: sessionId,
						command: selectedCommand,
					},
					(receipt) =>
						Effect.gen(function* () {
							if (
								receipt.eventIds.length > 0 &&
								command._tag === "SetProvider"
							) {
								if (resume !== null) {
									const current = yield* providerContexts.returning(
										sessionId,
										command.providerId as ProviderId,
									);
									if (
										current?.threadId !== resume.threadId ||
										current.throughSequence !== resume.throughSequence ||
										JSON.stringify(current.pendingMessageIds) !==
											JSON.stringify(resume.pendingMessageIds)
									)
										return yield* new SessionConfigurationError({
											sessionId,
											reason:
												"Provider history changed while switching. Retry the provider selection.",
										});
								}
								yield* providerContexts.remember(
									sessionId,
									previous.providerThread?.id ?? null,
								);
								yield* handoffs.capture(
									sessionId,
									command.providerId as ProviderId,
									receipt.eventIds[0]!,
									resume ?? undefined,
								);
							}
						}),
				)
				.pipe(
					Effect.catchTag(["SessionNotFound", "SessionDeletedConflict"], () =>
						Effect.fail(new SessionNotFoundError({ sessionId })),
					),
					Effect.catchTag("ValidationFailed", (error) =>
						Effect.fail(
							new SessionConfigurationError({
								sessionId,
								reason: error.message,
							}),
						),
					),
					Effect.catch((error) =>
						error._tag === "SessionNotFoundError" ||
						error._tag === "SessionConfigurationError"
							? Effect.fail(error)
							: Effect.die(error),
					),
				);
		});

	const setModel: ConversationOperations["setModel"] = (sessionId, model) =>
		configureProvider(sessionId, {
			_tag: "SetModel",
			model,
			updatedAt: Date.now(),
		});

	const releaseProvider: ConversationOperations["releaseProvider"] = (
		sessionId,
	) =>
		Effect.gen(function* () {
			const session = yield* lookupSession(sessionId);
			if (session.status === "running" || session.status === "booting")
				return false;
			yield* closeProvider(sessionId);
			yield* interruptProviderFiber(sessionId);
			return true;
		});

	const setProvider: ConversationOperations["setProvider"] = (
		sessionId,
		providerId,
		model,
	) =>
		configureProvider(sessionId, {
			_tag: "SetProvider",
			providerId,
			model,
			updatedAt: Date.now(),
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
			yield* closeProvider(sessionId);
			yield* interruptProviderFiber(sessionId);
		});

	const releaseInitialTurn: ConversationOperations["releaseInitialTurn"] = (
		commandId,
		sessionId,
		turnId,
		providerInputJson,
	) =>
		Effect.gen(function* () {
			yield* dispatchSessionCommandWithId(sessionId, commandId, {
				_tag: "ReleaseInitialTurn",
				expectedTurnId: turnId,
				providerInputJson,
				requestedAt: yield* currentTimestamp,
			});
			yield* runSessionReactors(sessionId);
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

			yield* closeProvider(sessionId);
			yield* teardownSubscription(sessionId);
			yield* dispatchSessionCommand(sessionId, {
				_tag: "DeleteSession",
				deletedAt: yield* currentTimestamp,
			});
			yield* Effect.sync(() => state.clearSession(sessionId));
		});

	return {
		recoverPlanResponses: planDelivery.recover,
		reconcilePlanInputs: makePlanExpiry(
			sql,
			sessionDomain,
			provider,
			planDelivery,
			(sessionId, itemId, work) =>
				inputResolutionWorker.run(
					structuralTupleKey("plan", sessionId, itemId),
					work,
				),
		),
		listSessions,
		ensureForTurn,
		createSession,
		renameSession,
		setRuntimeMode,
		setPermissionMode,
		answerQuestion,
		cancelQuestion,
		respondToPlan,
		setWorktree,
		setModel,
		setProvider,
		releaseProvider,
		archiveSession,
		unarchiveSession,
		deleteSession,
		releaseInitialTurn,
	};
};
