import {
	type AttachmentRef,
	type ComposerAnnotation,
	DirectoryUnavailableError,
	type FileRef,
	type MessageContent,
	type MessageId,
	type MessageOrigin,
	type Session,
	SessionId,
	SessionNotFoundError,
	SessionStartError,
	type SkillRef,
} from "@zuse/contracts";
import type { SessionCommand } from "@zuse/domain/core/commands";
import { Effect, type FileSystem, type Scope } from "effect";
import type { SqlClient } from "effect/unstable/sql";
import type { ProviderServiceShape } from "../../provider/services/provider-service.ts";
import type { ConversationOperations } from "../services/conversation-services.ts";
import { isGoalCapableProvider } from "./conversation-goal-operations.ts";
import type { ConversationGoalState } from "./conversation-goal-state.ts";
import {
	formatProviderFailure,
	looksLikeAuthFailure,
	serializeAnnotations,
} from "./conversation-input.ts";
import type { PersistedMessage } from "./conversation-store-types.ts";
import type { QueueServiceRuntime } from "./queue-service-runtime.ts";
import { makeQueueServiceRuntime } from "./queue-service-runtime.ts";

export interface MessageOperationsOptions {
	readonly sql: SqlClient.SqlClient;
	readonly fs: FileSystem.FileSystem;
	readonly provider: ProviderServiceShape;
	readonly goalState: ConversationGoalState;
	readonly lookupSession: ConversationOperations["getSession"];
	readonly openProviderSession: (
		session: Session,
		options?: {
			readonly initialPrompt?: string;
			readonly postBootStatus?: Session["status"];
			readonly sendAfterOpen?: {
				readonly text: string;
				readonly attachments: ReadonlyArray<AttachmentRef>;
			};
		},
	) => Effect.Effect<void, SessionStartError>;
	readonly setStatus: (
		sessionId: SessionId,
		status: Session["status"],
	) => Effect.Effect<void>;
	readonly persistMessage: (
		sessionId: SessionId,
		content: MessageContent,
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
	readonly beginTurn: (sessionId: SessionId) => Effect.Effect<string>;
	readonly settleActiveTurn: (
		sessionId: SessionId,
		reason: "completed" | "interrupted" | "error",
	) => Effect.Effect<void>;
	readonly serviceScope: Scope.Scope;
	readonly recoverStatus: (
		sessionId: SessionId,
		status: Session["status"],
	) => Effect.Effect<void>;
	readonly closeProvider: (sessionId: SessionId) => Effect.Effect<void>;
	readonly interruptProviderFiber: (
		sessionId: SessionId,
	) => Effect.Effect<void>;
}

export interface MessageOperations {
	readonly resumeSession: ConversationOperations["resumeSession"];
	readonly sendMessage: ConversationOperations["sendMessage"];
	readonly interruptSession: ConversationOperations["interruptSession"];
	readonly queueRuntime: QueueServiceRuntime;
}

export const makeMessageOperations = Effect.fn("MessageOperations.make")(
	function* (options: MessageOperationsOptions) {
		const {
			sql,
			fs,
			provider,
			goalState,
			lookupSession,
			openProviderSession,
			setStatus,
			persistMessage,
			ndjsonAppend,
			setGoal,
			dispatchSessionCommand,
			beginTurn,
			settleActiveTurn,
			serviceScope,
			recoverStatus,
			closeProvider,
			interruptProviderFiber,
		} = options;
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
			settleActiveTurn,
			setQueuePaused: (sessionId, paused) =>
				dispatchSessionCommand(sessionId, {
					_tag: "SetQueuePaused",
					paused,
					updatedAt: Date.now(),
				}),
		});
		// Boot recovery runs only after the real queue runtime exists. Demoting a
		// stale session to idle invokes setStatus → flushAfterIdle, so installing
		// this dependency first is what guarantees durable queued work resumes.
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
				yield* settleActiveTurn(sessionId, "error");
			}
			yield* recoverStatus(
				sessionId,
				stale.status === "running" ? "idle" : "error",
			);
			if (stale.status === "running") {
				yield* Effect.forkIn(
					queueRuntime.flushAfterIdle(sessionId),
					serviceScope,
				);
			}
		}

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

		return { resumeSession, sendMessage, interruptSession, queueRuntime };
	},
);
