import type { FileSystem, Path } from "@effect/platform";
import type { SqlClient } from "@effect/sql";
import { Effect } from "effect";

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
  sessionId: string,
  fallbackRoot?: string,
): Effect.Effect<string | null> =>
  Effect.gen(function* () {
    const sessions = yield* sql<SessionRow>`
      SELECT project_id, worktree_id FROM sessions WHERE id = ${sessionId} LIMIT 1
    `.pipe(Effect.orElseSucceed(() => [] as ReadonlyArray<SessionRow>));
    const session = sessions[0];
    if (session === undefined) return fallbackRoot ?? null;

    if (session.worktree_id !== null) {
      const wt = yield* sql<PathRow>`
        SELECT path FROM worktrees WHERE id = ${session.worktree_id} LIMIT 1
      `.pipe(Effect.orElseSucceed(() => [] as ReadonlyArray<PathRow>));
      if (wt[0] !== undefined) return wt[0].path;
    }

    const proj = yield* sql<PathRow>`
      SELECT path FROM projects WHERE id = ${session.project_id} LIMIT 1
    `.pipe(Effect.orElseSucceed(() => [] as ReadonlyArray<PathRow>));
    return proj[0]?.path ?? fallbackRoot ?? null;
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
