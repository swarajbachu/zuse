import type { FileSystem, Path } from "effect";
import { Effect } from "effect";
import type { SqlClient } from "effect/unstable/sql";

/**
 * Shared helpers for writing files into a workspace's gitignored
 * `.context/files/` directory. Both the attachment upload path (images and
 * dropped files) and `context.saveText` (big text pastes) land here so the
 * bytes live inside the agent's cwd instead of hidden app data.
 *
 * The functions take service *instances* (rather than requiring them from the
 * Effect context) so callers that captured `SqlClient` / `FileSystem` / `Path`
 * at layer-construction time can reuse them without widening their effect's
 * `R` channel.
 */

interface SessionRow {
	readonly project_id: string;
	readonly worktree_id: string | null;
	readonly archived_worktree_json: string | null;
}
interface PathRow {
	readonly path: string;
}

/**
 * Resolve the workspace cwd a session runs in: the worktree path when the
 * session is pinned to one, otherwise the project's checkout. Falls back to
 * `fallbackRoot` (a renderer-supplied root) when the session row does not
 * exist yet — e.g. a brand-new chat before its first send. Returns `null`
 * when nothing resolves.
 */
export const resolveSessionCwd = (
	sql: SqlClient.SqlClient,
	fs: FileSystem.FileSystem,
	sessionId: string,
	fallbackRoot?: string,
): Effect.Effect<string | null> =>
	Effect.gen(function* () {
		const sessions = yield* sql<SessionRow>`
      SELECT s.project_id, s.worktree_id, c.archived_worktree_json
      FROM sessions s
      INNER JOIN chats c ON c.id = s.chat_id
      WHERE s.id = ${sessionId} LIMIT 1
    `.pipe(Effect.orElseSucceed(() => [] as ReadonlyArray<SessionRow>));
		const session = sessions[0];
		if (session === undefined) {
			if (fallbackRoot === undefined) return null;
			return (yield* fs
				.exists(fallbackRoot)
				.pipe(Effect.orElseSucceed(() => false)))
				? fallbackRoot
				: null;
		}
		if (session.worktree_id === null && session.archived_worktree_json !== null)
			return null;

		if (session.worktree_id !== null) {
			const wt = yield* sql<PathRow>`
        SELECT path FROM worktrees WHERE id = ${session.worktree_id} LIMIT 1
      `.pipe(Effect.orElseSucceed(() => [] as ReadonlyArray<PathRow>));
			if (wt[0] !== undefined) {
				return (yield* fs
					.exists(wt[0].path)
					.pipe(Effect.orElseSucceed(() => false)))
					? wt[0].path
					: null;
			}
		}

		const proj = yield* sql<PathRow>`
      SELECT path FROM projects WHERE id = ${session.project_id} LIMIT 1
    `.pipe(Effect.orElseSucceed(() => [] as ReadonlyArray<PathRow>));
		const resolved = proj[0]?.path ?? fallbackRoot ?? null;
		if (resolved === null) return null;
		return (yield* fs.exists(resolved).pipe(Effect.orElseSucceed(() => false)))
			? resolved
			: null;
	});

/**
 * Absolute path of `<cwd>/.context/files`, created (recursively) if missing.
 * `.context` is already registered in the project's `.gitignore` at workspace
 * registration, so files written here are ignored by git.
 */
export const ensureContextFilesDir = (
	fs: FileSystem.FileSystem,
	pathSvc: Path.Path,
	cwd: string,
): Effect.Effect<string> =>
	Effect.gen(function* () {
		const dir = pathSvc.join(cwd, ".context", "files");
		yield* fs.makeDirectory(dir, { recursive: true }).pipe(Effect.orDie);
		return dir;
	});
