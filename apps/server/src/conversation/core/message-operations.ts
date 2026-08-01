import {
	AgentTurnId,
	type AttachmentRef,
	type ComposerAnnotation,
	ComposerInput,
	DirectoryUnavailableError,
	type FileRef,
	type MessageContent,
	type MessageId,
	type MessageOrigin,
	type Session,
	SessionId,
	type SessionNotFoundError,
	type SessionStartError,
	type SkillRef,
} from "@zuse/contracts";
import type { SessionCommand } from "@zuse/domain/core/commands";
import { Deferred, Effect, type FileSystem, type Scope } from "effect";
import type { SqlClient } from "effect/unstable/sql";
import type { ConversationOperations } from "../services/conversation-services.ts";
import { isGoalCapableProvider } from "./conversation-goal-operations.ts";
import type { ConversationGoalState } from "./conversation-goal-state.ts";
import { serializeAnnotations } from "./conversation-input.ts";
import type { PersistedMessage } from "./conversation-store-types.ts";
import type { OpenProviderSessionOptions } from "./provider-session-runtime.ts";
import {
	decodeProviderModelOptions,
	decodeProviderStartRequest,
	decodeProviderTurnInput,
} from "./provider-turn-request.ts";
import type { QueueServiceRuntime } from "./queue-service-runtime.ts";
import { makeQueueServiceRuntime } from "./queue-service-runtime.ts";

export interface MessageOperationsOptions {
	readonly sql: SqlClient.SqlClient;
	readonly fs: FileSystem.FileSystem;
	readonly goalState: ConversationGoalState;
	readonly lookupSession: ConversationOperations["getSession"];
	readonly ensureForTurn: (
		sessionId: SessionId,
		options?: OpenProviderSessionOptions,
	) => Effect.Effect<boolean, SessionStartError>;
	readonly setStatus: (
		sessionId: SessionId,
		status: Session["status"],
	) => Effect.Effect<void>;
	readonly persistMessage: (
		sessionId: SessionId,
		content: MessageContent,
		idOverride?: MessageId,
		turnIdOverride?: AgentTurnId,
	) => Effect.Effect<PersistedMessage>;
	readonly submitTurn: (
		sessionId: SessionId,
		turnId: AgentTurnId,
		content: MessageContent,
		providerInputJson: string,
		idOverride?: MessageId,
	) => Effect.Effect<PersistedMessage>;
	readonly ndjsonAppend: (
		sessionId: SessionId,
		persisted: PersistedMessage,
	) => Effect.Effect<void>;
	readonly setGoal: ConversationOperations["setGoal"];
	readonly dispatchSessionCommand: (
		sessionId: SessionId,
		command: SessionCommand,
	) => Effect.Effect<void>;
	readonly dispatchSessionCommandWithId: (
		sessionId: SessionId,
		commandId: string,
		command: SessionCommand,
	) => Effect.Effect<void>;
	readonly beginTurn: (
		sessionId: SessionId,
		turnIdOverride?: AgentTurnId,
	) => Effect.Effect<AgentTurnId>;
	readonly settleTurn: (
		sessionId: SessionId,
		turnId: AgentTurnId,
		reason: "completed" | "interrupted" | "error",
	) => Effect.Effect<void>;
	readonly resolveActiveTurn: (
		sessionId: SessionId,
	) => Effect.Effect<AgentTurnId | undefined>;
	readonly runSessionReactors: Effect.Effect<void>;
	readonly serviceScope: Scope.Scope;
	readonly recoverStatus: (
		sessionId: SessionId,
		status: Session["status"],
	) => Effect.Effect<void>;
	readonly closeProvider: (sessionId: SessionId) => Effect.Effect<void>;
	readonly hasProvider: (sessionId: SessionId) => Effect.Effect<boolean>;
	readonly interruptProviderFiber: (
		sessionId: SessionId,
	) => Effect.Effect<void>;
}

export interface MessageOperations {
	readonly resumeSession: ConversationOperations["resumeSession"];
	readonly sendMessage: ConversationOperations["sendMessage"];
	readonly interruptSession: ConversationOperations["interruptSession"];
	readonly queueRuntime: QueueServiceRuntime;
	readonly runStartupRecovery: <E>(
		catchUp: Effect.Effect<void, E>,
	) => Effect.Effect<void>;
	readonly withStartupRecovery: <A, E, R>(
		effect: Effect.Effect<A, E, R>,
	) => Effect.Effect<A, E, R>;
}

export const makeMessageOperations = Effect.fn("MessageOperations.make")(
	function* (options: MessageOperationsOptions) {
		const {
			sql,
			fs,
			goalState,
			lookupSession,
			ensureForTurn,
			setStatus,
			persistMessage,
			submitTurn,
			ndjsonAppend,
			setGoal,
			dispatchSessionCommand,
			beginTurn,
			settleTurn,
			resolveActiveTurn,
			runSessionReactors,
			serviceScope,
			recoverStatus,
			closeProvider,
			hasProvider,
			interruptProviderFiber,
		} = options;
		const pendingProviderTurn = (sessionId: SessionId, turnId: AgentTurnId) =>
			Effect.gen(function* () {
				// Startup options live on SessionCreated for dormant sessions and on
				// the turn for atomic initial prompts. COALESCE supports both histories.
				const rows = yield* sql<{
					readonly provider_input_json: string;
					readonly provider_start_json: string | null;
				}>`
					SELECT
						json_extract(payload_json, '$.providerInputJson') AS provider_input_json,
						COALESCE(
							json_extract(payload_json, '$.providerStartJson'),
							(
								SELECT json_extract(created.payload_json, '$.providerStartJson')
								FROM events created
								WHERE created.stream_kind = 'session'
									AND created.stream_id = ${sessionId}
									AND created.type = 'SessionCreated'
								ORDER BY created.stream_version ASC
								LIMIT 1
							)
						) AS provider_start_json
					FROM events
					WHERE stream_kind = 'session'
						AND stream_id = ${sessionId}
						AND type = 'ProviderTurnRequested'
						AND json_extract(payload_json, '$.turnId') = ${turnId}
					ORDER BY stream_version DESC
					LIMIT 1
				`.pipe(Effect.orDie);
				const row = rows[0];
				if (row === undefined) return null;
				const input = yield* decodeProviderTurnInput(
					row.provider_input_json,
				).pipe(Effect.orDie);
				const startup =
					row.provider_start_json === null
						? null
						: yield* decodeProviderStartRequest(row.provider_start_json).pipe(
								Effect.orDie,
							);
				const modelOptions =
					startup?.modelOptionsJson == null
						? undefined
						: yield* decodeProviderModelOptions(startup.modelOptionsJson).pipe(
								Effect.orDie,
							);
				return { input, startup, modelOptions };
			});
		const restartSession: ConversationOperations["resumeSession"] = (
			sessionId,
		) =>
			Effect.gen(function* () {
				const session = yield* lookupSession(sessionId);
				// Best-effort cleanup of any stale in-memory session before opening
				// a fresh handle attached to the same DB row. Renderer subscriptions
				// stay connected across the reopen — only the event-pump fiber needs
				// to restart. A null cursor starts a fresh provider process for the
				// same durable Zuse session; a persisted cursor resumes provider
				// context when the driver supports it.
				yield* closeProvider(sessionId);
				yield* interruptProviderFiber(sessionId);
				const turnId = yield* resolveActiveTurn(sessionId);
				const request =
					turnId === undefined
						? null
						: yield* pendingProviderTurn(sessionId, turnId);
				// When a durable turn is active, reopen replays that exact request. The
				// renderer must not submit the last user message again after success.
				yield* ensureForTurn(session.id, {
					initialPrompt: request?.startup?.initialPrompt ?? undefined,
					initialTurnId: request?.startup?.initialTurnId ?? undefined,
					modelOptions: request?.modelOptions,
					enableSubagents: request?.startup?.enableSubagents,
					forkFromResume: request?.startup?.forkFromResume,
					postBootStatus: request === null ? "idle" : "running",
					...(request === null || turnId === undefined
						? {}
						: {
								sendAfterOpen: {
									turnId,
									text: request.input.text,
									attachments: request.input.attachments,
									fileRefs: request.input.fileRefs,
									skillRefs: request.input.skillRefs,
								},
							}),
				});
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
		): Effect.Effect<
			boolean,
			SessionNotFoundError | DirectoryUnavailableError
		> =>
			Effect.gen(function* () {
				const session = yield* lookupSession(sessionId);
				const directoryRows = yield* sql<{
					readonly project_id: string;
					readonly project_path: string | null;
					readonly worktree_id: string | null;
					readonly worktree_path: string | null;
					readonly archived_worktree_json: string | null;
				}>`
          SELECT c.project_id, p.path AS project_path, c.worktree_id,
                 w.path AS worktree_path, c.archived_worktree_json
          FROM chats c
          LEFT JOIN projects p ON p.id = c.project_id
          LEFT JOIN worktrees w ON w.id = c.worktree_id
          WHERE c.id = ${session.chatId}
          LIMIT 1
        `.pipe(Effect.orDie);
				const directory = directoryRows[0];
				if (directory !== undefined) {
					const expectsWorktree =
						directory.worktree_id !== null ||
						directory.archived_worktree_json !== null;
					const path = expectsWorktree
						? directory.worktree_path
						: directory.project_path;
					const available =
						path !== null &&
						(yield* fs.exists(path).pipe(Effect.orElseSucceed(() => false)));
					if (!available) {
						yield* closeProvider(sessionId).pipe(Effect.ignore);
						yield* interruptProviderFiber(sessionId).pipe(Effect.ignore);
						return yield* Effect.fail(
							new DirectoryUnavailableError({
								folderId: session.projectId,
								worktreeId: session.worktreeId,
								reason: expectsWorktree
									? "worktree-missing"
									: "project-missing",
							}),
						);
					}
				}
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
				const turnId = AgentTurnId.make(`turn_${crypto.randomUUID()}`);
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
				const providerInput = new ComposerInput({
					text: sendText,
					attachments: cleanAttachments,
					fileRefs: fileRefs ?? [],
					skillRefs: skillRefs ?? [],
					annotations: annotationList,
				});
				const persisted =
					asGoal === true
						? yield* beginTurn(sessionId, turnId).pipe(
								Effect.andThen(
									persistMessage(sessionId, content, clientMessageId, turnId),
								),
							)
						: yield* submitTurn(
								sessionId,
								turnId,
								content,
								JSON.stringify(providerInput),
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
				if (!accepted) {
					const turnId = yield* resolveActiveTurn(sessionId);
					if (turnId !== undefined)
						yield* settleTurn(sessionId, turnId, "error");
				}
			});

		const queueRuntime = yield* makeQueueServiceRuntime({
			serviceScope,
			sql,
			lookupSession,
			submitUserMessage: (sessionId, input, clientMessageId) =>
				submitUserMessage(
					sessionId,
					input.text,
					input.attachments,
					input.fileRefs,
					input.skillRefs,
					input.annotations,
					input.asGoal,
					clientMessageId,
				),
			setQueuePaused: (sessionId, paused) =>
				dispatchSessionCommand(sessionId, {
					_tag: "SetQueuePaused",
					paused,
					updatedAt: Date.now(),
				}),
			dispatchSessionCommand,
			dispatchSessionCommandWithId: (sessionId, commandId, command) =>
				options.dispatchSessionCommandWithId(sessionId, commandId, command),
			runSessionReactors,
			resolveActiveTurn,
		});
		// Recovery can reopen a provider turn that waits for user input (for
		// example, a permission decision). Keep it owned by the service scope, but
		// never block construction of the RPC layer on that long-lived work.
		const recoverStaleSessions = Effect.gen(function* () {
			const staleSessions = yield* sql<{
				readonly id: string;
				readonly status: "running" | "booting";
			}>`
				SELECT id, status FROM sessions
				WHERE status IN ('running', 'booting') AND archived_at IS NULL
			`.pipe(Effect.orDie);
			for (const stale of staleSessions) {
				const sessionId = SessionId.make(stale.id);
				if (stale.status === "running") {
					const turnId = yield* resolveActiveTurn(sessionId);
					if (turnId !== undefined) {
						// Catch-up may have just recreated this provider and replayed the
						// unfinished turn. Only settle rows whose in-memory owner is gone.
						if (yield* hasProvider(sessionId)) continue;
						const lifecycle = yield* sql<{ readonly type: string }>`
							SELECT type FROM events
							WHERE stream_kind = 'session' AND stream_id = ${sessionId}
								AND type IN (
									'TurnInterruptRequested',
									'TurnInterruptAcknowledged',
									'TurnSettled'
								)
							ORDER BY stream_version DESC
							LIMIT 1
						`.pipe(Effect.orDie);
						const interrupted =
							lifecycle[0]?.type.startsWith("TurnInterrupt") === true;
						yield* settleTurn(
							sessionId,
							turnId,
							interrupted ? "interrupted" : "error",
						);
					} else {
						yield* recoverStatus(sessionId, "error");
					}
				} else {
					yield* restartSession(sessionId).pipe(
						Effect.catch(() => recoverStatus(sessionId, "error")),
					);
				}
			}
		});
		const startupRecoveryDone = yield* Deferred.make<void>();
		const runStartupRecovery = <E>(catchUp: Effect.Effect<void, E>) =>
			catchUp.pipe(
				Effect.andThen(recoverStaleSessions),
				Effect.catch((error) =>
					Effect.logError(
						`[ConversationServices] startup recovery failed: ${String(error)}`,
					),
				),
				Effect.ensuring(Deferred.succeed(startupRecoveryDone, undefined)),
			);
		const withStartupRecovery = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
			Deferred.await(startupRecoveryDone).pipe(Effect.andThen(effect));
		const resumeSession: ConversationOperations["resumeSession"] = (
			sessionId,
		) =>
			Effect.gen(function* () {
				// A manual retry can arrive as soon as RPC becomes available while
				// durable startup recovery is still reopening the same provider. Join
				// that single flight instead of closing its newly recovered handle.
				yield* withStartupRecovery(Effect.void);
				const session = yield* lookupSession(sessionId);
				if (session.status !== "error" && (yield* hasProvider(sessionId))) {
					return session;
				}
				return yield* restartSession(sessionId);
			});
		const interruptSession: ConversationOperations["interruptSession"] = (
			sessionId,
		) =>
			Effect.gen(function* () {
				yield* lookupSession(sessionId);
				const resolvedTurnId = yield* resolveActiveTurn(sessionId);
				if (resolvedTurnId === undefined) return;
				yield* dispatchSessionCommand(sessionId, {
					_tag: "RequestTurnInterrupt",
					turnId: resolvedTurnId,
					requestedAt: Date.now(),
				});
				yield* queueRuntime.pauseAfterInterrupt(sessionId);
				yield* runSessionReactors;
			});

		return {
			resumeSession,
			sendMessage,
			interruptSession,
			queueRuntime,
			runStartupRecovery,
			withStartupRecovery,
		};
	},
);
