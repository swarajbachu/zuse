import {
	ChatId,
	FolderId,
	PermissionDecision,
	RpcAccessDeniedError,
	SessionId,
	WorktreeId,
} from "@zuse/contracts";
import { Clock, Effect, Option, Schema } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { CatalogVisibility } from "../../collaboration/services/catalog-visibility.ts";
import { WorkspaceFileAccess } from "../../collaboration/services/workspace-file-access.ts";
import { PermissionService } from "../../provider/services/permission-service.ts";
import { PtyService } from "../../pty/services/pty-service.ts";
import { workspacePtyService } from "../../pty/workspace-pty-service.ts";
import type { WorkspaceCredentialIdentity } from "../services/connection-identity.ts";

type Target =
	| "handshake"
	| "catalog"
	| "chat"
	| "session"
	| "file"
	| "terminal";
const policy = new Map<string, { target: Target; edit: boolean }>();
const register = (
	target: Target,
	edit: boolean,
	tags: ReadonlyArray<string>,
) => {
	for (const tag of tags) policy.set(tag, { target, edit });
};
register("handshake", false, ["connect.handshake", "ping.ping"]);

// Aggregate resource usage only; host configuration and runtime control stay denied.
register("catalog", false, ["machine.resources.watch", "simulators.state"]);
register("chat", false, ["simulators.frames", "simulators.screenshot"]);
register("chat", true, [
	"simulators.open",
	"simulators.close",
	"simulators.input",
]);
register("catalog", false, ["permission.requests"]);
register("catalog", true, ["permission.decide"]);
register("session", false, [
	"schedule.list",
	"secrets.list",
	"permission.listPending",
]);
register("terminal", false, ["pty.list", "pty.output"]);
register("terminal", true, [
	"pty.open",
	"pty.write",
	"pty.resize",
	"pty.close",
	"pty.rename",
	"pty.restart",
]);
register("catalog", false, [
	"workspace.list",
	"workspace.streamChanges",
	"chat.list",
	"chat.streamChanges",
	"session.list",
	"session.streamChanges",
	"chat.creation.list",
	"chat.creation.stream",
]);
register("chat", false, [
	"chat.get",
	"chat.directoryStatus",
	"chat.archiveStatus",
]);
register("chat", true, ["chat.rename", "chat.markRead"]);
register("session", false, [
	"session.get",
	"session.checkpoints.list",
	"session.attempts.list",
	"session.latestPlan",
	"session.contextLinks",
	"session.wait",
	"session.forkConstructions",
	"session.exportTranscript",
	"messages.list",
	"messages.queue.list",
	"session.events",
	"session.events.head",
	"session.messages.page",
	"session.goal.get",
	"session.goal.stream",
	"attachments.read",
]);
register("session", true, [
	"schedule.create",
	"schedule.update",
	"schedule.delete",
	"schedule.trigger",
	"secrets.request",
	"secrets.respond",
	"session.rename",
	"session.mergeBack",
	"session.sendAndWait",
	"session.retryFork",
	"session.cancelFork",
	"session.checkpoints.preview",
	"session.checkpoints.restore",
	"session.checkpoints.retry",
	"session.setModel",
	"session.setProvider",
	"session.setRuntimeMode",
	"session.setPermissionMode",
	"session.resume",
	"session.answerQuestion",
	"session.cancelQuestion",
	"session.plan.respond",
	"session.goal.set",
	"session.goal.clear",
	"messages.send",
	"messages.interrupt",
	"messages.background.stop",
	"messages.queue.add",
	"messages.queue.update",
	"messages.queue.delete",
	"messages.queue.runNext",
	"messages.queue.reorder",
	"messages.queue.flush",
	"messages.queue.resume",
]);
register("file", false, [
	"fs.readFile",
	"fs.tree",
	"fs.listPaths",
	"fs.watchTree",
	"git.log",
	"git.status",
	"git.branches",
	"git.userName",
	"git.origin",
	"git.githubContext",
	"git.workspaceChanges",
	"git.changes",
	"git.workspaceSnapshot",
	"git.prDetails",
	"git.diff",
	"git.reviewPatches",
	"git.reviewFileContents",
	"git.reviewSummary",
	"reviewGuide.stream",
]);
register("file", true, ["reviewGuide.generate", "reviewGuide.cancel"]);
register("file", true, [
	"fs.writeFile",
	"fs.createFile",
	"fs.createDirectory",
	"fs.remove",
	"fs.move",
	"git.commit",
	"git.push",
	"git.pull",
	"git.stash",
	"git.stashPop",
	"git.resolveConflict",
]);

/** A cloud grant never delegates host credentials, arbitrary filesystem access or other chats. */
export const authorizeWorkspaceRpc = Effect.fn("authorizeWorkspaceRpc")(
	function* <A, E, R>(
		effect: Effect.Effect<A, E, R>,
		identity: WorkspaceCredentialIdentity,
		tag: string,
		payload: unknown,
	) {
		const rule = policy.get(tag);
		if (rule === undefined)
			return yield* new RpcAccessDeniedError({ code: "access-denied" });
		const sql = yield* SqlClient.SqlClient;
		const authorize = Effect.gen(function* () {
			if (identity.expiresAt <= (yield* Clock.currentTimeMillis))
				return yield* new RpcAccessDeniedError({ code: "credential-expired" });
			const permission = yield* identity.authorize;
			if (identity.expiresAt <= (yield* Clock.currentTimeMillis))
				return yield* new RpcAccessDeniedError({ code: "credential-expired" });
			if (rule.edit && permission !== "edit")
				return yield* new RpcAccessDeniedError({ code: "access-denied" });
			const rows = yield* sql<{
				project_id: string;
				worktree_id: string | null;
			}>`SELECT project_id, worktree_id FROM chats WHERE id=${identity.chatId}`;
			const chat = rows[0];
			if (chat === undefined || chat.project_id !== identity.projectId)
				return yield* new RpcAccessDeniedError({ code: "access-denied" });
			if (tag === "permission.decide") {
				const input = yield* Schema.decodeUnknownEffect(
					Schema.Struct({
						requestId: Schema.String,
						decision: PermissionDecision,
					}),
				)(payload);

				if (input.decision._tag === "AlwaysAllow")
					return yield* new RpcAccessDeniedError({ code: "access-denied" });
				const service = yield* Effect.serviceOption(PermissionService);
				if (Option.isNone(service))
					return yield* new RpcAccessDeniedError({ code: "access-denied" });
				const sessions = yield* sql<{
					id: string;
				}>`SELECT id FROM sessions WHERE chat_id=${identity.chatId}`;
				let found = false;
				for (const session of sessions) {
					const pending = yield* service.value.listPending(
						SessionId.make(session.id),
					);
					if (pending.some((request) => request.id === input.requestId)) {
						found = true;
						break;
					}
				}
				if (!found)
					return yield* new RpcAccessDeniedError({ code: "access-denied" });
			}
			if (rule.target === "chat") {
				const input = yield* Schema.decodeUnknownEffect(
					Schema.Struct({ chatId: ChatId }),
				)(payload);
				if (input.chatId !== identity.chatId)
					return yield* new RpcAccessDeniedError({ code: "access-denied" });
			}
			if (rule.target === "session") {
				const input = yield* Schema.decodeUnknownEffect(
					Schema.Struct({ sessionId: SessionId }),
				)(payload);
				const sessions = yield* sql<{
					chat_id: string;
				}>`SELECT chat_id FROM sessions WHERE id=${input.sessionId}`;
				if (sessions[0]?.chat_id !== identity.chatId)
					return yield* new RpcAccessDeniedError({ code: "access-denied" });
				if (tag === "session.retryFork" || tag === "session.cancelFork") {
					const forkInput = yield* Schema.decodeUnknownEffect(
						Schema.Struct({ forkSessionId: Schema.String }),
					)(payload);
					const forks = yield* sql<{
						chat_id: string;
					}>`SELECT json_extract(payload_json,'$.chatId') AS chat_id FROM session_fork_constructions WHERE session_id=${forkInput.forkSessionId}`;
					if (forks[0]?.chat_id !== identity.chatId)
						return yield* new RpcAccessDeniedError({ code: "access-denied" });
				}
				if (tag === "session.mergeBack") {
					const parents = yield* sql<{
						chat_id: string;
					}>`SELECT parent.chat_id FROM sessions child JOIN sessions parent ON parent.id=child.forked_from_session_id WHERE child.id=${input.sessionId}`;
					if (parents[0]?.chat_id !== identity.chatId)
						return yield* new RpcAccessDeniedError({ code: "access-denied" });
				}
			}
			if (rule.target === "file") {
				const input = yield* Schema.decodeUnknownEffect(
					Schema.Struct({
						folderId: FolderId,
						worktreeId: Schema.optional(Schema.NullOr(WorktreeId)),
					}),
				)(payload);
				if (
					input.folderId !== identity.projectId ||
					(input.worktreeId ?? null) !== chat.worktree_id
				)
					return yield* new RpcAccessDeniedError({ code: "access-denied" });
			}
			let terminalDirectory: string | undefined;
			if (rule.target === "terminal") {
				const directories = yield* sql<{ path: string | null }>`
					SELECT CASE WHEN c.worktree_id IS NULL THEN p.path ELSE w.path END AS path
					FROM chats c JOIN projects p ON p.id = c.project_id
					LEFT JOIN worktrees w ON w.id = c.worktree_id AND w.project_id = c.project_id
					WHERE c.id = ${identity.chatId}`;
				const path = directories[0]?.path;
				if (!path)
					return yield* new RpcAccessDeniedError({ code: "access-denied" });
				terminalDirectory = path;
			}
			return {
				permission,
				terminalDirectory,
				folderId: identity.projectId,
				worktreeId:
					chat.worktree_id === null ? null : WorktreeId.make(chat.worktree_id),
			};
		}).pipe(
			Effect.mapError(
				() => new RpcAccessDeniedError({ code: "access-denied" }),
			),
		);
		const fileScope = yield* authorize;
		let scoped = effect.pipe(
			Effect.provideService(CatalogVisibility, {
				chats: new Set([identity.chatId]),
				projects: new Set([identity.projectId]),
				editableChats: new Set(
					fileScope.permission === "edit" ? [identity.chatId] : [],
				),
			}),
			Effect.provideService(WorkspaceFileAccess, fileScope),
		);
		if (fileScope.terminalDirectory !== undefined) {
			const terminals = yield* Effect.serviceOption(PtyService);
			if (Option.isNone(terminals))
				return yield* new RpcAccessDeniedError({ code: "access-denied" });
			scoped = scoped.pipe(
				Effect.provideService(
					PtyService,
					workspacePtyService(terminals.value, {
						chatId: identity.chatId,
						cwd: fileScope.terminalDirectory,
					}),
				),
			);
		}
		return yield* Effect.raceFirst(
			scoped,
			Effect.forever(
				Effect.gen(function* () {
					const now = yield* Clock.currentTimeMillis;
					yield* Effect.sleep(
						Math.max(0, Math.min(20_000, identity.expiresAt - now)),
					);
					const current = yield* authorize;
					if (
						current.worktreeId !== fileScope.worktreeId ||
						current.terminalDirectory !== fileScope.terminalDirectory
					)
						return yield* new RpcAccessDeniedError({ code: "access-denied" });
				}),
			),
		);
	},
);
