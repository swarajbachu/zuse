import {
	ChatAlreadyStartedError,
	type ChatArchiveJob,
	type ChatArchiveResult,
	ChatArchiveWorktreeError,
	ChatId,
	ChatNotFoundError,
	type FolderId,
	SessionId,
	type Worktree,
	WorktreeCheckpointError,
	WorktreeId,
} from "@zuse/contracts";
import type { ChatCommand } from "@zuse/domain/chat/commands";
import type { SessionCommand } from "@zuse/domain/core/commands";
import type {
	WorktreeArchiveOutcome,
	WorktreeServiceShape,
} from "@zuse/git/worktree-service";
import {
	Effect,
	Fiber,
	FileSystem,
	Path,
	Ref,
	Schema,
	Semaphore,
} from "effect";
import type { SqlClient } from "effect/unstable/sql";
import type { makeReactorEffectJournal } from "../../provider/reactor-effect-journal.ts";
import type { PtyServiceShape } from "../../pty/services/pty-service.ts";
import type { RepositorySettingsServiceShape } from "../../repository-settings/services/repository-settings-service.ts";
import type { ConversationOperations } from "../services/conversation-services.ts";
import { runArchiveScript } from "./conversation-archive-script.ts";
import type {
	ConversationReactorHandlers,
	ConversationReactorRuntime,
} from "./conversation-reactors.ts";
import {
	type ChatRow,
	parseArchivedWorktreeSnapshot,
	type SessionRow,
	sessionFromRow,
} from "./conversation-records.ts";
import type { ConversationStateApi } from "./conversation-state.ts";

const WorktreeArchiveOutcomeSchema = Schema.Struct({
	archiveCommit: Schema.String,
	checkpointCreated: Schema.Boolean,
	archiveRef: Schema.NullOr(Schema.String),
	archivedContextPath: Schema.NullOr(Schema.String),
	branch: Schema.String,
});
const WorktreeCheckpointJournalDetailSchema = Schema.Struct({
	id: Schema.String,
	projectId: Schema.String,
	path: Schema.String,
	name: Schema.String,
	branch: Schema.String,
	baseBranch: Schema.String,
	createdAt: Schema.String,
	outcome: WorktreeArchiveOutcomeSchema,
});
const decodeWorktreeCheckpointJournalDetail = Schema.decodeUnknownEffect(
	Schema.fromJsonString(WorktreeCheckpointJournalDetailSchema),
);
const checkpointSummary = (
	outcome: WorktreeArchiveOutcome,
): NonNullable<ChatArchiveResult["checkpoint"]> => ({
	archiveCommit: outcome.archiveCommit,
	checkpointCreated: outcome.checkpointCreated,
	archiveRef: outcome.archiveRef,
	branch: outcome.branch,
});
const isHandledGitRequirementFailure = (reason: string): boolean => {
	const normalized = reason.trim().toLowerCase();
	return (
		normalized === "git is not installed" ||
		normalized.includes("not a git repository")
	);
};

export interface ArchiveOperationsOptions {
	readonly sql: SqlClient.SqlClient;
	readonly currentTimestamp: Effect.Effect<number>;
	readonly lookupChat: ConversationOperations["getChat"];
	readonly dispatchChatCommand: (
		chatId: ChatId,
		command: ChatCommand,
		commandId?: string,
	) => Effect.Effect<void>;
	readonly dispatchSessionCommand: (
		sessionId: SessionId,
		command: SessionCommand,
	) => Effect.Effect<void>;
	readonly appendSessionCommand: (
		sessionId: SessionId,
		command: SessionCommand,
	) => Effect.Effect<void>;
	readonly closeProvider: (sessionId: SessionId) => Effect.Effect<void>;
	readonly interruptProviderFiber: (
		sessionId: SessionId,
	) => Effect.Effect<void>;
	readonly teardownSubscription: (sessionId: SessionId) => Effect.Effect<void>;
	readonly setStatus: (
		sessionId: SessionId,
		status: "booting" | "idle" | "running" | "closed" | "error",
	) => Effect.Effect<void>;
	readonly repositorySettings: RepositorySettingsServiceShape;
	readonly worktrees: WorktreeServiceShape;
	readonly ptys: PtyServiceShape;
	readonly projectPath: (projectId: FolderId) => Effect.Effect<string | null>;
	readonly reactorEffects: ReturnType<typeof makeReactorEffectJournal>;
	readonly state: ConversationStateApi;
}

export const makeArchiveOperations = Effect.fn("ArchiveOperations.make")(
	function* (options: ArchiveOperationsOptions) {
		const {
			sql,
			currentTimestamp,
			lookupChat,
			dispatchChatCommand,
			dispatchSessionCommand,
			appendSessionCommand,
			closeProvider,
			interruptProviderFiber,
			teardownSubscription,
			setStatus,
			repositorySettings,
			worktrees,
			ptys,
			projectPath,
			reactorEffects,
			state,
		} = options;
		const fs = yield* FileSystem.FileSystem;
		const path = yield* Path.Path;
		const archiveWorkerPermits = yield* Semaphore.make(4);
		const keyedLockGuard = yield* Semaphore.make(1);
		const chatAcceptanceLocks = new Map<string, Semaphore.Semaphore>();
		const worktreeLockGuard = yield* Semaphore.make(1);
		const worktreeLocks = new Map<string, Semaphore.Semaphore>();
		const archiveWorkerScope = yield* Effect.scope;
		const archiveCleanupFibers = new Map<ChatId, Fiber.Fiber<void, never>>();
		const withKeyedLock = <A, E, R>(
			locks: Map<string, Semaphore.Semaphore>,
			key: string,
			effect: Effect.Effect<A, E, R>,
		) =>
			Effect.gen(function* () {
				const lock = yield* keyedLockGuard.withPermits(1)(
					Effect.gen(function* () {
						const existing = locks.get(key);
						if (existing !== undefined) return existing;
						const created = yield* Semaphore.make(1);
						locks.set(key, created);
						return created;
					}),
				);
				return yield* lock.withPermits(1)(effect);
			});
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
		type ArchiveJobRow = {
			readonly chat_id: string;
			readonly command_id: string;
			readonly status: ChatArchiveJob["status"];
			readonly phase: string;
			readonly worktree_id: string | null;
			readonly snapshot_json: string | null;
			readonly acceptance_sessions_json: string;
			readonly cleanup_output: string;
			readonly error: string | null;
			readonly updated_at: string;
		};
		const archiveJobFromRow = (row: ArchiveJobRow): ChatArchiveJob => ({
			chatId: ChatId.make(row.chat_id),
			status: row.status,
			phase: row.phase,
			error: row.error,
			cleanupOutput: row.cleanup_output,
			updatedAt: new Date(row.updated_at),
		});
		const archiveJobRow = (chatId: ChatId) =>
			sql<ArchiveJobRow>`
				SELECT chat_id, command_id, status, phase, worktree_id, snapshot_json, acceptance_sessions_json,
               cleanup_output, error, updated_at
        FROM chat_archive_jobs WHERE chat_id = ${chatId} LIMIT 1
      `.pipe(
				Effect.orDie,
				Effect.map((rows) => rows[0] ?? null),
			);
		const normalizeHandledArchiveFailure = (row: ArchiveJobRow) =>
			Effect.gen(function* () {
				if (
					row.status !== "failed" ||
					row.error === null ||
					!isHandledGitRequirementFailure(row.error)
				) {
					return row;
				}
				let phase = "retained-no-git";
				if (row.worktree_id !== null) {
					const worktree = yield* worktrees.get(
						WorktreeId.make(row.worktree_id),
					);
					const directoryExists =
						worktree !== null &&
						(yield* fs
							.exists(worktree.path)
							.pipe(Effect.orElseSucceed(() => false)));
					if (!directoryExists) phase = "directory-missing";
				}
				const updatedAt = new Date().toISOString();
				yield* sql`
					UPDATE chat_archive_jobs
					SET status = 'completed', phase = ${phase}, error = NULL,
					    updated_at = ${updatedAt}
					WHERE chat_id = ${row.chat_id} AND status = 'failed'
				`.pipe(Effect.orDie);
				return {
					...row,
					status: "completed" as const,
					phase,
					error: null,
					updated_at: updatedAt,
				};
			});

		const getArchiveStatus: ConversationOperations["getArchiveStatus"] = (
			chatId,
		) =>
			Effect.gen(function* () {
				yield* lookupChat(chatId);
				const row = yield* archiveJobRow(chatId);
				// Repair jobs written by older cleanup workers that promoted an
				// expected no-Git condition into a terminal failure. These jobs are
				// already logically archived and must not advertise Force archive.
				return row === null
					? null
					: archiveJobFromRow(yield* normalizeHandledArchiveFailure(row));
			});
		const listArchiveJobs: ConversationOperations["listArchiveJobs"] = (
			projectId,
		) =>
			sql<ArchiveJobRow>`
				SELECT j.chat_id, j.command_id, j.status, j.phase, j.worktree_id, j.snapshot_json, j.acceptance_sessions_json,
               j.cleanup_output, j.error, j.updated_at
        FROM chat_archive_jobs j
        INNER JOIN chats c ON c.id = j.chat_id
        WHERE c.project_id = ${projectId}
          AND j.status IN ('queued', 'running', 'failed')
        ORDER BY j.updated_at DESC
			`.pipe(
				Effect.orDie,
				Effect.flatMap((rows) =>
					Effect.forEach(rows, normalizeHandledArchiveFailure),
				),
				Effect.map((rows) =>
					rows
						.filter(
							(row) =>
								row.status === "queued" ||
								row.status === "running" ||
								row.status === "failed",
						)
						.map(archiveJobFromRow),
				),
			);

		const jobMayContinue = (chatId: ChatId) =>
			archiveJobRow(chatId).pipe(
				Effect.map(
					(row) =>
						row !== null &&
						(row.status === "queued" || row.status === "running"),
				),
			);
		const worktreeMayBeRemoved = (worktreeId: WorktreeId) =>
			sql<{ readonly present: number }>`
				SELECT 1 AS present
				FROM chats c
				LEFT JOIN sessions s ON s.chat_id = c.id AND s.archived_at IS NULL
				WHERE c.archived_at IS NULL
				  AND (c.worktree_id = ${worktreeId} OR s.worktree_id = ${worktreeId})
				LIMIT 1
			`.pipe(
				Effect.orDie,
				Effect.map((rows) => rows.length === 0),
			);
		const claimWorktreeRemoval = (worktreeId: WorktreeId) =>
			Effect.gen(function* () {
				yield* sql`
					UPDATE worktrees SET archive_state = 'deleting'
					WHERE id = ${worktreeId}
					  AND archive_state = 'active'
					  AND NOT EXISTS (
						SELECT 1 FROM chats c
						LEFT JOIN sessions s
						  ON s.chat_id = c.id AND s.archived_at IS NULL
						WHERE c.archived_at IS NULL
						  AND (c.worktree_id = ${worktreeId} OR s.worktree_id = ${worktreeId})
					  )
				`.pipe(Effect.orDie);
				const rows = yield* sql<{ readonly archive_state: string }>`
					SELECT archive_state FROM worktrees WHERE id = ${worktreeId} LIMIT 1
				`.pipe(Effect.orDie);
				return rows[0]?.archive_state === "deleting";
			});
		const releaseWorktreeRemoval = (worktreeId: WorktreeId) =>
			sql`
				UPDATE worktrees SET archive_state = 'active'
				WHERE id = ${worktreeId} AND archive_state = 'deleting'
			`.pipe(Effect.asVoid, Effect.orDie);
		const cleanupMayRemoveWorktree = (chatId: ChatId, worktreeId: WorktreeId) =>
			Effect.all([
				jobMayContinue(chatId),
				sql<{ readonly archive_state: string }>`
					SELECT archive_state FROM worktrees WHERE id = ${worktreeId} LIMIT 1
				`.pipe(
					Effect.orDie,
					Effect.map((rows) => rows[0]?.archive_state === "deleting"),
				),
			]).pipe(
				Effect.map(
					([jobActive, removalClaimed]) => jobActive && removalClaimed,
				),
			);
		type AcceptanceSession = {
			readonly id: SessionId;
			readonly archivedAt: number | null;
		};
		const acceptanceSessions = (
			row: ArchiveJobRow,
		): ReadonlyArray<AcceptanceSession> => {
			try {
				const decoded: unknown = JSON.parse(row.acceptance_sessions_json);
				if (!Array.isArray(decoded)) return [];
				return decoded.flatMap((value): ReadonlyArray<AcceptanceSession> => {
					if (typeof value === "string") {
						return [{ id: SessionId.make(value), archivedAt: null }];
					}
					if (
						typeof value === "object" &&
						value !== null &&
						"id" in value &&
						typeof value.id === "string" &&
						"archivedAt" in value &&
						typeof value.archivedAt === "number"
					) {
						return [
							{ id: SessionId.make(value.id), archivedAt: value.archivedAt },
						];
					}
					return [];
				});
			} catch {
				return [];
			}
		};
		const rollbackInterruptedAcceptance = (
			row: ArchiveJobRow,
			reason: string,
		) =>
			Effect.gen(function* () {
				const unarchivedAt = yield* currentTimestamp;
				for (const session of acceptanceSessions(row)) {
					const current = yield* sql<{ readonly archived_at: number | null }>`
						SELECT archived_at FROM sessions WHERE id = ${session.id} LIMIT 1
					`.pipe(Effect.orDie);
					if (
						session.archivedAt !== null &&
						current[0]?.archived_at === session.archivedAt
					) {
						yield* dispatchSessionCommand(session.id, {
							_tag: "UnarchiveSession",
							unarchivedAt,
						});
					}
				}
				yield* updateJob(ChatId.make(row.chat_id), "failed", "acceptance", {
					error: reason,
				});
			});

		const updateJob = (
			chatId: ChatId,
			status: ChatArchiveJob["status"],
			phase: string,
			options?: { readonly error?: string | null; readonly output?: string },
		) =>
			sql`
        UPDATE chat_archive_jobs
        SET status = ${status}, phase = ${phase},
            error = ${options?.error ?? null},
            cleanup_output = COALESCE(${options?.output ?? null}, cleanup_output),
            updated_at = ${new Date().toISOString()}
        WHERE chat_id = ${chatId}
      `.pipe(Effect.asVoid, Effect.orDie);
		const forceArchiveJob = (chatId: ChatId) =>
			Effect.gen(function* () {
				const previous = yield* archiveJobRow(chatId);
				if (
					previous !== null &&
					(previous.status === "queued" || previous.status === "running")
				) {
					yield* updateJob(chatId, "cancelled", "force-requested");
				}
				const cleanupFiber = archiveCleanupFibers.get(chatId);
				if (cleanupFiber !== undefined) {
					if (previous?.phase === "cleanup-script") {
						yield* Fiber.interrupt(cleanupFiber);
					} else {
						// Do not durably publish `forced` while an irreversible removal may
						// already be past its final cancellation boundary.
						yield* Fiber.await(cleanupFiber);
					}
				}
				const current = yield* archiveJobRow(chatId);
				yield* finalizeForceRequest(chatId, current);
			});
		const repairRetainedArchiveContext = (row: ArchiveJobRow) =>
			Effect.gen(function* () {
				if (row.worktree_id === null) return;
				const journalRows = yield* sql<{ readonly detail_json: string | null }>`
					SELECT detail_json FROM reactor_effect_steps
					WHERE effect_id = ${row.command_id}
					  AND step = 'worktree-checkpoint'
					  AND status = 'completed'
					LIMIT 1
				`.pipe(Effect.orDie);
				const detailJson = journalRows[0]?.detail_json;
				if (detailJson === undefined || detailJson === null) return;
				const detail = yield* decodeWorktreeCheckpointJournalDetail(
					detailJson,
				).pipe(Effect.orElseSucceed(() => null));
				const archivedContextPath = detail?.outcome.archivedContextPath ?? null;
				if (archivedContextPath === null) return;
				const worktree = yield* worktrees.get(WorktreeId.make(row.worktree_id));
				if (worktree === null) return;
				const contextSource = path.join(worktree.path, ".context");
				const sourceExists = yield* fs
					.exists(contextSource)
					.pipe(Effect.orElseSucceed(() => false));
				const destinationExists = yield* fs
					.exists(archivedContextPath)
					.pipe(Effect.orElseSucceed(() => false));
				if (!sourceExists && destinationExists) {
					yield* fs
						.rename(archivedContextPath, contextSource)
						.pipe(Effect.orDie);
				}
				// This update is intentionally idempotent. If a process exits after the
				// rename but before SQL is repaired, the next startup finishes the job.
				yield* sql`
					UPDATE attachments
					SET abs_path = replace(abs_path, ${archivedContextPath}, ${contextSource})
					WHERE abs_path IS NOT NULL
					  AND abs_path LIKE ${`${archivedContextPath}/%`}
				`.pipe(Effect.orDie);
			});
		const finalizeForceRequest = (chatId: ChatId, row: ArchiveJobRow | null) =>
			Effect.gen(function* () {
				if (row !== null && row.worktree_id !== null) {
					const existing = yield* worktrees.get(
						WorktreeId.make(row.worktree_id),
					);
					if (existing === null) {
						const snapshot = parseArchivedWorktreeSnapshot(row.snapshot_json);
						const journalRows = yield* sql<{
							readonly detail_json: string | null;
						}>`
							SELECT detail_json FROM reactor_effect_steps
							WHERE effect_id = ${row.command_id}
							  AND step = 'worktree-checkpoint'
							  AND status = 'completed'
							LIMIT 1
						`.pipe(Effect.orDie);
						const detailJson = journalRows[0]?.detail_json;
						if (
							snapshot === null ||
							detailJson === undefined ||
							detailJson === null
						) {
							return yield* Effect.fail(
								new ChatArchiveWorktreeError({
									chatId,
									reason:
										"The removed worktree has no completed checkpoint to restore.",
								}),
							);
						}
						const detail = yield* decodeWorktreeCheckpointJournalDetail(
							detailJson,
						).pipe(
							Effect.mapError(
								(cause) =>
									new ChatArchiveWorktreeError({
										chatId,
										reason: `Stored checkpoint result is invalid: ${String(cause)}`,
									}),
							),
						);
						const restoredSnapshot = { ...snapshot, ...detail.outcome };
						yield* worktrees
							.restore({
								id: WorktreeId.make(restoredSnapshot.id),
								projectId: restoredSnapshot.projectId as FolderId,
								path: restoredSnapshot.path,
								name: restoredSnapshot.name,
								branch: restoredSnapshot.branch,
								baseBranch: restoredSnapshot.baseBranch,
								createdAt: new Date(restoredSnapshot.createdAt),
								archiveCommit: restoredSnapshot.archiveCommit,
								checkpointCreated: restoredSnapshot.checkpointCreated,
								archiveRef: restoredSnapshot.archiveRef,
								archivedContextPath: restoredSnapshot.archivedContextPath,
							})
							.pipe(
								Effect.mapError(
									(error) =>
										new ChatArchiveWorktreeError({
											chatId,
											reason: `Force archive could not restore the removed worktree: ${String(error)}`,
										}),
								),
							);
						const restoredJson = JSON.stringify(restoredSnapshot);
						yield* sql`
							UPDATE chats SET archived_worktree_json = ${restoredJson}
							WHERE id = ${chatId}
						`.pipe(Effect.orDie);
						yield* sql`
							UPDATE chat_archive_jobs SET snapshot_json = ${restoredJson}
							WHERE chat_id = ${chatId}
						`.pipe(Effect.orDie);
					} else {
						yield* repairRetainedArchiveContext(row);
					}
				}
				const now = new Date().toISOString();
				yield* sql`
					INSERT INTO chat_archive_jobs
						(chat_id, command_id, status, phase, worktree_id, snapshot_json,
						 cleanup_output, error, created_at, updated_at)
					SELECT id, ${`force:${chatId}:${now}`}, 'forced', 'forced', worktree_id,
					       archived_worktree_json, '', NULL, ${now}, ${now}
					FROM chats WHERE id = ${chatId}
					ON CONFLICT(chat_id) DO UPDATE SET
						status = 'forced', phase = 'forced', error = NULL,
						updated_at = excluded.updated_at
				`.pipe(Effect.orDie);
			});

		const runArchiveCleanup = Effect.fn("ArchiveOperations.runCleanup")(
			function* (chatId: ChatId) {
				const row = yield* archiveJobRow(chatId);
				if (row === null || !(yield* jobMayContinue(chatId))) return;
				// Cleanup scripts are not assumed to be idempotent. If the process died
				// while one was running, surface a real failure instead of running it twice.
				if (row.status === "running" && row.phase === "cleanup-script") {
					yield* updateJob(chatId, "failed", "cleanup-script", {
						error: "The cleanup script was interrupted before it completed.",
					});
					return;
				}
				const snapshot = parseArchivedWorktreeSnapshot(row.snapshot_json);
				if (snapshot === null) {
					yield* updateJob(chatId, "failed", "snapshot", {
						error: "The archived worktree snapshot is unavailable.",
					});
					return;
				}
				yield* updateJob(chatId, "running", "stopping-resources");
				const sessionRows = yield* sql<{ readonly id: string }>`
          SELECT id FROM sessions WHERE chat_id = ${chatId}
        `.pipe(Effect.orDie);
				for (const sessionRow of sessionRows) {
					const sessionId = SessionId.make(sessionRow.id);
					yield* closeProvider(sessionId).pipe(Effect.ignore);
					yield* interruptProviderFiber(sessionId).pipe(Effect.ignore);
				}
				const worktreeId = WorktreeId.make(snapshot.id);
				const worktree = yield* worktrees.get(worktreeId);
				if (worktree === null) {
					const siblingJobs = yield* sql<{
						readonly snapshot_json: string | null;
					}>`
						SELECT j.snapshot_json
						FROM chat_archive_jobs j
						WHERE j.worktree_id = ${worktreeId}
						  AND j.chat_id <> ${chatId}
						  AND j.status = 'completed'
						  AND j.snapshot_json IS NOT NULL
						ORDER BY j.updated_at DESC
						LIMIT 1
					`.pipe(Effect.orDie);
					const siblingSnapshot = parseArchivedWorktreeSnapshot(
						siblingJobs[0]?.snapshot_json ?? null,
					);
					if (
						siblingSnapshot?.archiveCommit !== undefined ||
						siblingSnapshot?.archiveRef !== undefined
					) {
						const completedSnapshot = JSON.stringify(siblingSnapshot);
						yield* sql`
							UPDATE chats SET archived_worktree_json = ${completedSnapshot}
							WHERE id = ${chatId} AND archived_at IS NOT NULL
						`.pipe(Effect.orDie);
						yield* sql`
							UPDATE chat_archive_jobs SET snapshot_json = ${completedSnapshot}
							WHERE chat_id = ${chatId}
						`.pipe(Effect.orDie);
						yield* updateJob(chatId, "completed", "completed");
						return;
					}
					const completedSteps = yield* sql<{
						readonly detail_json: string | null;
					}>`
            SELECT detail_json FROM reactor_effect_steps
            WHERE effect_id = ${row.command_id}
              AND step = 'worktree-checkpoint'
              AND status = 'completed'
            LIMIT 1
          `.pipe(Effect.orDie);
					const detailJson = completedSteps[0]?.detail_json;
					if (detailJson !== undefined && detailJson !== null) {
						const detail = yield* decodeWorktreeCheckpointJournalDetail(
							detailJson,
						).pipe(
							Effect.mapError(
								(cause) =>
									new ChatArchiveWorktreeError({
										chatId,
										reason: `Stored checkpoint result is invalid: ${String(cause)}`,
									}),
							),
						);
						const completedSnapshot = JSON.stringify({
							...snapshot,
							...detail.outcome,
						});
						yield* sql`
              UPDATE chats SET archived_worktree_json = ${completedSnapshot}
              WHERE id = ${chatId} AND archived_at IS NOT NULL
            `.pipe(Effect.orDie);
						yield* sql`
              UPDATE chat_archive_jobs SET snapshot_json = ${completedSnapshot}
              WHERE chat_id = ${chatId}
            `.pipe(Effect.orDie);
						yield* updateJob(chatId, "completed", "completed");
						return;
					}
					yield* updateJob(chatId, "failed", "worktree", {
						error: "The worktree record is unavailable.",
					});
					return;
				}
				if (!(yield* worktreeMayBeRemoved(worktreeId))) {
					yield* updateJob(chatId, "completed", "retained-shared");
					return;
				}
				const worktreeDirectoryExists = yield* fs
					.exists(worktree.path)
					.pipe(Effect.orElseSucceed(() => false));
				if (!worktreeDirectoryExists) {
					yield* updateJob(chatId, "completed", "directory-missing");
					return;
				}
				yield* ptys.closeByCwdPrefix(worktree.path).pipe(Effect.ignore);
				const chat = yield* lookupChat(chatId);
				const settings = yield* repositorySettings.get(chat.projectId);
				const script = settings.archiveCleanupScript?.trim() ?? "";
				let cleanupOutput = row.cleanup_output;
				if (
					script.length > 0 &&
					row.phase !== "checkpoint" &&
					(yield* jobMayContinue(chatId))
				) {
					yield* updateJob(chatId, "running", "cleanup-script");
					const rootPath = yield* projectPath(chat.projectId);
					const cleanup = yield* runArchiveScript({
						chatId,
						script,
						cwd: worktree.path,
						env: {
							ZUSE_ROOT_PATH: rootPath ?? "",
							ZUSE_WORKSPACE_PATH: worktree.path,
							ZUSE_CHAT_ID: chatId,
							ZUSE_WORKTREE_ID: worktree.id,
						},
					});
					cleanupOutput = cleanup.output;
					yield* updateJob(chatId, "running", "checkpoint", {
						output: cleanupOutput,
					});
				}
				if (!(yield* jobMayContinue(chatId))) return;
				if (!(yield* claimWorktreeRemoval(worktreeId))) {
					yield* updateJob(chatId, "completed", "retained-shared", {
						output: cleanupOutput,
					});
					return;
				}
				yield* sql`
          INSERT INTO reactor_effect_steps
            (effect_id, step, status, detail_json, updated_at)
          VALUES
            (${row.command_id}, 'worktree-checkpoint', 'started',
             ${row.snapshot_json}, ${new Date().toISOString()})
          ON CONFLICT(effect_id, step) DO NOTHING
        `.pipe(Effect.orDie);
				const archiveResult = yield* worktrees
					.archive(
						worktree.id,
						(checkpoint) =>
							sql`
            UPDATE reactor_effect_steps
            SET status = 'completed',
                detail_json = ${JSON.stringify({ ...snapshot, outcome: checkpoint })},
                updated_at = ${new Date().toISOString()}
            WHERE effect_id = ${row.command_id} AND step = 'worktree-checkpoint'
          `.pipe(
								Effect.asVoid,
								Effect.mapError(
									(error) =>
										new WorktreeCheckpointError({
											worktreeId: worktree.id,
											reason: `checkpoint journal update failed: ${String(error)}`,
										}),
								),
							),
						() => cleanupMayRemoveWorktree(chatId, worktreeId),
					)
					.pipe(
						Effect.result,
						Effect.ensuring(releaseWorktreeRemoval(worktreeId)),
					);
				if (archiveResult._tag === "Failure") {
					const error = archiveResult.failure;
					if (error._tag === "WorktreeNotFoundError") {
						yield* updateJob(chatId, "completed", "directory-missing", {
							output: cleanupOutput,
						});
						return;
					}
					if (
						error._tag === "WorktreeCheckpointError" &&
						isHandledGitRequirementFailure(error.reason)
					) {
						const directoryStillExists = yield* fs
							.exists(worktree.path)
							.pipe(Effect.orElseSucceed(() => false));
						yield* updateJob(
							chatId,
							"completed",
							directoryStillExists ? "retained-no-git" : "directory-missing",
							{
								output: cleanupOutput,
							},
						);
						return;
					}
					return yield* Effect.fail(error);
				}
				const outcome = archiveResult.success;
				if (!(yield* jobMayContinue(chatId))) return;
				const completedSnapshot = JSON.stringify({ ...snapshot, ...outcome });
				yield* sql`
          UPDATE chats SET archived_worktree_json = ${completedSnapshot}
          WHERE id = ${chatId} AND archived_at IS NOT NULL
        `.pipe(Effect.orDie);
				yield* sql`
					UPDATE chat_archive_jobs SET snapshot_json = ${completedSnapshot}
					WHERE chat_id = ${chatId}
				`.pipe(Effect.orDie);
				// Every archived chat sharing this checkout must inherit the same
				// checkpoint. Later unarchives can then restore even though only one
				// worker performed the destructive work.
				yield* sql`
					UPDATE chats SET archived_worktree_json = ${completedSnapshot}
					WHERE id IN (
						SELECT chat_id FROM chat_archive_jobs WHERE worktree_id = ${worktreeId}
					) AND archived_at IS NOT NULL
				`.pipe(Effect.orDie);
				yield* sql`
					UPDATE chat_archive_jobs
					SET snapshot_json = ${completedSnapshot},
					    status = CASE WHEN status IN ('queued', 'running') THEN 'completed' ELSE status END,
					    phase = CASE WHEN status IN ('queued', 'running') THEN 'completed' ELSE phase END,
					    updated_at = ${new Date().toISOString()}
					WHERE worktree_id = ${worktreeId}
				`.pipe(Effect.orDie);
				yield* updateJob(chatId, "completed", "completed", {
					output: cleanupOutput,
				});
			},
		);
		const runArchiveCleanupWithWorktreeLock = (chatId: ChatId) =>
			Effect.gen(function* () {
				const row = yield* archiveJobRow(chatId);
				const snapshot = parseArchivedWorktreeSnapshot(
					row?.snapshot_json ?? null,
				);
				if (snapshot === null) return yield* runArchiveCleanup(chatId);
				const lock = yield* worktreeLockGuard.withPermits(1)(
					Effect.gen(function* () {
						const existing = worktreeLocks.get(snapshot.id);
						if (existing !== undefined) return existing;
						const created = yield* Semaphore.make(1);
						worktreeLocks.set(snapshot.id, created);
						return created;
					}),
				);
				yield* lock.withPermits(1)(runArchiveCleanup(chatId));
			});

		const scheduleArchiveCleanup = (chatId: ChatId) =>
			Effect.gen(function* () {
				if (archiveCleanupFibers.has(chatId)) return;
				const cleanup = archiveWorkerPermits
					.withPermits(1)(
						runArchiveCleanupWithWorktreeLock(chatId).pipe(
							Effect.catch((error) =>
								updateJob(chatId, "failed", "failed", {
									error:
										"reason" in Object(error) &&
										typeof (error as { reason?: unknown }).reason === "string"
											? (error as { reason: string }).reason
											: String(error),
									output:
										"output" in Object(error) &&
										typeof (error as { output?: unknown }).output === "string"
											? (error as { output: string }).output
											: undefined,
								}),
							),
						),
					)
					.pipe(
						Effect.ensuring(
							Effect.sync(() => {
								archiveCleanupFibers.delete(chatId);
							}),
						),
					);
				const fiber = yield* Effect.forkIn(cleanup, archiveWorkerScope);
				archiveCleanupFibers.set(chatId, fiber);
			});

		const acceptChatArchive = (
			chatId: ChatId,
			commandId: string,
			force: boolean,
		) =>
			Effect.gen(function* () {
				const chat = yield* lookupChat(chatId);
				if (chat.archivedAt !== null) {
					if (force) yield* forceArchiveJob(chatId);
					const existing = yield* archiveJobRow(chatId);
					return {
						chat,
						cleanup: null,
						checkpoint: null,
						job: existing === null ? null : archiveJobFromRow(existing),
					};
				}
				const worktree =
					chat.worktreeId === null
						? null
						: yield* worktrees.get(chat.worktreeId);
				const snapshotJson =
					worktree === null
						? null
						: JSON.stringify({
								id: worktree.id,
								projectId: worktree.projectId,
								path: worktree.path,
								name: worktree.name,
								branch: worktree.branch,
								baseBranch: worktree.baseBranch,
								createdAt: worktree.createdAt.toISOString(),
							});
				const archivedAt = yield* currentTimestamp;
				let job: ChatArchiveJob | null = null;
				const acceptedAt = new Date().toISOString();
				const acceptingPhase = force ? "accepting-force" : "accepting";
				const liveSessions = yield* sql<{ readonly id: string }>`
					SELECT id FROM sessions WHERE chat_id = ${chatId} AND archived_at IS NULL
				`.pipe(Effect.orDie);
				const acceptanceSessionsJson = JSON.stringify(
					liveSessions.map(({ id }) => ({ id, archivedAt })),
				);
				// Establish the outbox row before changing logical archive state. The
				// cancelled/accepting marker is never runnable; restart recovery only
				// promotes it after observing the chat's durable archived projection.
				yield* sql`
		  INSERT INTO chat_archive_jobs
		    (chat_id, command_id, status, phase, worktree_id, snapshot_json,
		     acceptance_sessions_json, cleanup_output, error, created_at, updated_at)
		  VALUES
			  (${chatId}, ${commandId}, 'cancelled', ${acceptingPhase}, ${worktree?.id ?? null}, ${snapshotJson}, ${acceptanceSessionsJson},
		     '', NULL, ${acceptedAt}, ${acceptedAt})
          ON CONFLICT(chat_id) DO UPDATE SET
			command_id = excluded.command_id,
			status = 'cancelled', phase = ${acceptingPhase},
			worktree_id = COALESCE(chat_archive_jobs.worktree_id, excluded.worktree_id),
			acceptance_sessions_json = excluded.acceptance_sessions_json,
            snapshot_json = COALESCE(chat_archive_jobs.snapshot_json, excluded.snapshot_json),
            error = NULL, updated_at = excluded.updated_at
        `.pipe(Effect.orDie);
				const acceptanceExit = yield* Effect.gen(function* () {
					yield* Effect.forEach(
						liveSessions,
						({ id }) =>
							appendSessionCommand(SessionId.make(id), {
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
					const status = force
						? "forced"
						: worktree === null
							? "completed"
							: "queued";
					yield* updateJob(chatId, status, status);
					const inserted = yield* archiveJobRow(chatId);
					job = inserted === null ? null : archiveJobFromRow(inserted);
				}).pipe(Effect.exit);
				if (acceptanceExit._tag === "Failure") {
					const currentChat = yield* lookupChat(chatId);
					if (currentChat.archivedAt !== null) {
						const status = force
							? "forced"
							: worktree === null
								? "completed"
								: "queued";
						yield* updateJob(chatId, status, status);
						const inserted = yield* archiveJobRow(chatId);
						job = inserted === null ? null : archiveJobFromRow(inserted);
					} else {
						const acceptingRow = yield* archiveJobRow(chatId);
						if (acceptingRow !== null) {
							yield* rollbackInterruptedAcceptance(
								acceptingRow,
								"Archive acceptance failed before it completed.",
							);
						}
						return yield* Effect.failCause(acceptanceExit.cause);
					}
				}
				if (worktree !== null && !force) yield* scheduleArchiveCleanup(chatId);
				yield* reactorEffects.complete(commandId);
				return {
					chat: yield* lookupChat(chatId),
					cleanup: null,
					checkpoint: null,
					job,
				};
			});

		const chatArchiveResults = yield* Ref.make<
			ReadonlyMap<ChatId, ChatArchiveResult>
		>(new Map());
		const replayCompletedArchiveResult = (chatId: ChatId, commandId: string) =>
			Effect.gen(function* () {
				const jobRow = yield* archiveJobRow(chatId);
				const steps = yield* sql<{ readonly detail_json: string | null }>`
          SELECT detail_json FROM reactor_effect_steps
          WHERE effect_id = ${commandId}
            AND step = 'worktree-checkpoint'
            AND status = 'completed'
          LIMIT 1
        `.pipe(Effect.orDie);
				const detailJson = steps[0]?.detail_json;
				if (detailJson === undefined || detailJson === null) {
					return {
						chat: yield* lookupChat(chatId),
						cleanup: null,
						checkpoint: null,
						job: jobRow === null ? null : archiveJobFromRow(jobRow),
					};
				}
				const detail = yield* decodeWorktreeCheckpointJournalDetail(
					detailJson,
				).pipe(
					Effect.mapError(
						(cause) =>
							new ChatArchiveWorktreeError({
								chatId,
								reason: `Stored checkpoint result is invalid: ${String(cause)}`,
							}),
					),
				);
				return {
					chat: yield* lookupChat(chatId),
					cleanup: null,
					checkpoint: checkpointSummary(detail.outcome),
					job: jobRow === null ? null : archiveJobFromRow(jobRow),
				};
			});
		const handleChatArchive: ConversationReactorHandlers["chatArchive"] = (
			reactorInput,
		) =>
			Effect.gen(function* () {
				const chatId = ChatId.make(reactorInput.streamId);
				const completed = yield* reactorEffects.isCompleted(
					reactorInput.commandId,
				);
				const result = completed
					? yield* replayCompletedArchiveResult(chatId, reactorInput.commandId)
					: yield* acceptChatArchive(
							chatId,
							reactorInput.commandId,
							reactorInput.command.force,
						);
				yield* Ref.update(chatArchiveResults, (current) => {
					const next = new Map(current);
					next.set(chatId, result);
					return next;
				});
			});

		const archiveChatWithReactor = (
			chatId: Parameters<ConversationOperations["archiveChat"]>[0],
			force: boolean,
			runChatArchive: ConversationReactorRuntime["runChatArchive"],
		) =>
			withKeyedLock(
				chatAcceptanceLocks,
				chatId,
				Effect.gen(function* () {
					const chat = yield* lookupChat(chatId);
					if (chat.archivedAt !== null) {
						if (force) yield* forceArchiveJob(chatId);
						const jobRow = yield* archiveJobRow(chatId);
						return {
							chat,
							cleanup: null,
							checkpoint: null,
							job: jobRow === null ? null : archiveJobFromRow(jobRow),
						};
					}
					yield* dispatchChatCommand(chatId, {
						_tag: "RequestArchiveChat",
						requestedAt: yield* currentTimestamp,
						force,
					});
					yield* runChatArchive;
					const results = yield* Ref.get(chatArchiveResults);
					const result = results.get(chatId);
					if (result === undefined) {
						return yield* Effect.die(
							new Error(
								`chat archive reactor produced no result for ${chatId}`,
							),
						);
					}
					return result;
				}),
			);
		const stopUnavailableDirectoryResources = (
			chatId: ChatId,
			path: string | null,
		) =>
			Effect.gen(function* () {
				const sessions = yield* sql<{ readonly id: string }>`
						SELECT id FROM sessions WHERE chat_id = ${chatId}
					`.pipe(Effect.orDie);
				for (const row of sessions) {
					const sessionId = SessionId.make(row.id);
					yield* closeProvider(sessionId).pipe(Effect.ignore);
					yield* interruptProviderFiber(sessionId).pipe(Effect.ignore);
				}
				if (path !== null)
					yield* ptys.closeByCwdPrefix(path).pipe(Effect.ignore);
			});

		const getChatDirectoryStatus: ConversationOperations["getChatDirectoryStatus"] =
			(chatId) =>
				Effect.gen(function* () {
					const chat = yield* lookupChat(chatId);
					const rootPath = yield* projectPath(chat.projectId);
					const rootExists =
						rootPath !== null &&
						(yield* fs
							.exists(rootPath)
							.pipe(Effect.orElseSucceed(() => false)));
					if (!rootExists) {
						yield* stopUnavailableDirectoryResources(chatId, rootPath);
						return { _tag: "unavailable", reason: "project-missing" } as const;
					}
					const archivedRows = yield* sql<{
						readonly archived_worktree_json: string | null;
					}>`
            SELECT archived_worktree_json FROM chats WHERE id = ${chatId} LIMIT 1
          `.pipe(Effect.orDie);
					const archivedSnapshot = parseArchivedWorktreeSnapshot(
						archivedRows[0]?.archived_worktree_json ?? null,
					);
					const resolvedWorktreeId =
						chat.worktreeId ??
						(archivedSnapshot === null
							? null
							: WorktreeId.make(archivedSnapshot.id));
					if (resolvedWorktreeId === null)
						return { _tag: "available" } as const;
					const worktree = yield* worktrees.get(resolvedWorktreeId);
					if (
						worktree !== null &&
						(yield* fs
							.exists(worktree.path)
							.pipe(Effect.orElseSucceed(() => false)))
					) {
						return { _tag: "available" } as const;
					}
					if (chat.archivedAt !== null) {
						if (
							archivedSnapshot?.archiveCommit !== undefined ||
							archivedSnapshot?.archiveRef !== undefined
						) {
							return { _tag: "restorable" } as const;
						}
					}
					yield* stopUnavailableDirectoryResources(
						chatId,
						worktree?.path ?? archivedSnapshot?.path ?? null,
					);
					return { _tag: "unavailable", reason: "worktree-missing" } as const;
				});

		const unarchiveChat: ConversationOperations["unarchiveChat"] = (chatId) =>
			withKeyedLock(
				chatAcceptanceLocks,
				chatId,
				Effect.gen(function* () {
					const pendingJob = yield* archiveJobRow(chatId);
					if (
						pendingJob !== null &&
						(pendingJob.status === "queued" || pendingJob.status === "running")
					) {
						yield* updateJob(chatId, "cancelled", "unarchive");
					}
					const cleanupFiber = archiveCleanupFibers.get(chatId);
					if (cleanupFiber !== undefined) {
						if (pendingJob?.phase === "cleanup-script") {
							yield* Fiber.interrupt(cleanupFiber);
						} else {
							// Forced/cancelled jobs may still be finishing a cancellation-safe
							// checkpoint rollback. Never expose the checkout until that settles.
							yield* Fiber.await(cleanupFiber);
						}
					}
					if (pendingJob !== null) {
						yield* repairRetainedArchiveContext(pendingJob);
					}
					const chatRows = yield* sql<ChatRow>`
          SELECT id, project_id, worktree_id, title, title_provenance, active_session_id, origin_session_id,
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
					let restorationUnavailable = false;
					let restoredWorktreeId: WorktreeId | null =
						chatRow.worktree_id === null
							? null
							: WorktreeId.make(chatRow.worktree_id);
					if (snapshot !== null) {
						const existing = yield* worktrees.get(WorktreeId.make(snapshot.id));
						const existingIsIntact =
							existing !== null &&
							(yield* fs
								.exists(existing.path)
								.pipe(Effect.orElseSucceed(() => false)));
						if (existing !== null && existingIsIntact) {
							restoredWorktree = existing;
							restoredWorktreeId = existing.id;
						} else if (existing !== null) {
							// Retain the original association and restoration snapshot without
							// claiming that a missing checkout is usable.
							restoredWorktreeId = existing.id;
							restorationUnavailable = true;
						} else {
							// The archived snapshot is authoritative. A stale worktree_id can
							// outlive checkout removal when SQLite foreign-key cleanup has not
							// run yet; skipping restore here silently routes the chat to main.
							const restoration = yield* worktrees
								.restore({
									id: WorktreeId.make(snapshot.id),
									projectId: snapshot.projectId as FolderId,
									path: snapshot.path,
									name: snapshot.name,
									branch: snapshot.branch,
									baseBranch: snapshot.baseBranch,
									createdAt: new Date(snapshot.createdAt),
									archiveCommit: snapshot.archiveCommit,
									checkpointCreated: snapshot.checkpointCreated,
									archiveRef: snapshot.archiveRef,
									archivedContextPath: snapshot.archivedContextPath,
								})
								.pipe(Effect.result);
							if (restoration._tag === "Success") {
								restoredWorktree = restoration.success;
								restoredWorktreeId = restoredWorktree.id;
							} else {
								restorationUnavailable = true;
							}
						}
					}

					const unarchivedAt = yield* currentTimestamp;
					yield* dispatchChatCommand(chatId, {
						_tag: "UnarchiveChat",
						unarchivedAt,
						worktreeId: restoredWorktreeId,
					});
					if (restorationUnavailable) {
						yield* sql`
            UPDATE chats SET archived_worktree_json = ${chatRow.archived_worktree_json}
            WHERE id = ${chatId}
          `.pipe(Effect.orDie);
					}
					const archivedSessions = yield* sql<{
						readonly id: string;
					}>`
          SELECT id FROM sessions WHERE chat_id = ${chatId}
        `.pipe(Effect.orDie);
					for (const row of archivedSessions) {
						const sessionId = SessionId.make(row.id);
						if (restoredWorktreeId !== null) {
							// Always record the binding in the session event stream. The raw
							// SQL foreign key may temporarily appear correct after recreating a
							// worktree with the same id while the session projector still holds
							// the null produced by checkout removal.
							yield* dispatchSessionCommand(sessionId, {
								_tag: "SetWorktree",
								worktreeId: restoredWorktreeId,
								updatedAt: unarchivedAt,
							});
							// Worktree removal clears the read-model FK directly, outside the
							// event stream. If domain state already remembers this same id, the
							// idempotent command above emits no event, so explicitly repair the
							// projection to the value a full event replay would produce.
							yield* sql`
              UPDATE sessions SET worktree_id = ${restoredWorktreeId}
              WHERE id = ${sessionId}
            `.pipe(Effect.orDie);
						}
						if (chatRow.archived_at !== null) {
							yield* dispatchSessionCommand(sessionId, {
								_tag: "UnarchiveSession",
								unarchivedAt,
							});
						}
					}
					const sessions = yield* sql<SessionRow>`
          SELECT id, project_id, title, title_provenance, provider_id, model, status,
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
						directoryStatus: yield* getChatDirectoryStatus(chatId),
					};
				}),
			);

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
					yield* appendSessionCommand(sessionId, {
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

		const retainedArchiveJobs = yield* sql<ArchiveJobRow>`
			SELECT chat_id, command_id, status, phase, worktree_id, snapshot_json,
			       acceptance_sessions_json, cleanup_output, error, updated_at
			FROM chat_archive_jobs
			WHERE status IN ('forced', 'cancelled')
		`.pipe(Effect.orDie);
		for (const retainedJob of retainedArchiveJobs) {
			if (retainedJob.phase === "force-requested") {
				yield* finalizeForceRequest(
					ChatId.make(retainedJob.chat_id),
					retainedJob,
				).pipe(
					Effect.catch((error) =>
						updateJob(
							ChatId.make(retainedJob.chat_id),
							"failed",
							"force-restore",
							{
								error:
									"reason" in Object(error) &&
									typeof (error as { reason?: unknown }).reason === "string"
										? (error as { reason: string }).reason
										: String(error),
							},
						),
					),
				);
			} else {
				yield* repairRetainedArchiveContext(retainedJob);
			}
		}

		const abandonedAcceptances = yield* sql<ArchiveJobRow>`
			SELECT j.chat_id, j.command_id, j.status, j.phase, j.worktree_id, j.snapshot_json,
			       j.acceptance_sessions_json, j.cleanup_output, j.error, j.updated_at
			FROM chat_archive_jobs j
			INNER JOIN chats c ON c.id = j.chat_id
			WHERE j.status = 'cancelled'
			  AND j.phase IN ('accepting', 'accepting-force')
			  AND c.archived_at IS NULL
		`.pipe(Effect.orDie);
		for (const abandoned of abandonedAcceptances) {
			yield* rollbackInterruptedAcceptance(
				abandoned,
				"Archive acceptance was interrupted before it completed.",
			);
		}

		yield* sql`
				UPDATE chat_archive_jobs
				SET status = CASE
				      WHEN phase = 'accepting-force' THEN 'forced'
				      WHEN snapshot_json IS NULL THEN 'completed'
				      ELSE 'queued'
				    END,
				    phase = CASE
				      WHEN phase = 'accepting-force' THEN 'forced'
				      WHEN snapshot_json IS NULL THEN 'completed'
				      ELSE 'queued'
				    END,
				    updated_at = ${new Date().toISOString()}
				WHERE status = 'cancelled' AND phase IN ('accepting', 'accepting-force')
				  AND EXISTS (
				    SELECT 1 FROM chats c
				    WHERE c.id = chat_archive_jobs.chat_id AND c.archived_at IS NOT NULL
				  )
			`.pipe(Effect.orDie);
		const resumableArchiveJobs = yield* sql<{ readonly chat_id: string }>`
      SELECT chat_id FROM chat_archive_jobs
      WHERE status IN ('queued', 'running')
      ORDER BY created_at ASC
    `.pipe(Effect.orDie);
		for (const row of resumableArchiveJobs) {
			yield* scheduleArchiveCleanup(ChatId.make(row.chat_id));
		}

		return {
			setChatWorktree,
			setChatActiveSession,
			archiveChatWithReactor,
			getArchiveStatus,
			listArchiveJobs,
			getChatDirectoryStatus,
			unarchiveChat,
			deleteChatWithReactor: (
				chatId: ChatId,
				runChatDelete: ConversationReactorRuntime["runChatDelete"],
			) =>
				Effect.gen(function* () {
					yield* lookupChat(chatId);
					yield* dispatchChatCommand(chatId, {
						_tag: "RequestDeleteChat",
						requestedAt: yield* currentTimestamp,
					});
					yield* runChatDelete;
				}),
			handleChatArchive,
			handleChatDelete,
		};
	},
);
