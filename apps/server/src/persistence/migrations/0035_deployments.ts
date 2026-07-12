import { SqlClient } from "effect/unstable/sql";
import { Effect } from "effect";

/**
 * One-click deploy (ADR 0022): per-run history plus a per-project
 * provisioning cache so redeploys reuse the same Vercel project/subdomain
 * (build cache) and Convex project. Secrets (Convex OAuth bundle, deploy
 * keys) live in the keychain, never here.
 */
export const Migration0035Deployments = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS deployments (
      id                   TEXT PRIMARY KEY,
      project_id           TEXT NOT NULL,
      worktree_id          TEXT,
      status               TEXT NOT NULL,
      framework            TEXT NOT NULL,
      url                  TEXT,
      convex_url           TEXT,
      vercel_deployment_id TEXT,
      error_summary        TEXT,
      log_tail             TEXT,
      failed_phase         TEXT,
      created_at           TEXT NOT NULL,
      finished_at          TEXT
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_deployments_project
      ON deployments(project_id, created_at DESC)
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS deploy_projects (
      project_id             TEXT PRIMARY KEY,
      vercel_project_id      TEXT,
      vercel_project_name    TEXT,
      subdomain              TEXT,
      convex_project_id      TEXT,
      convex_deployment_name TEXT,
      convex_url             TEXT,
      updated_at             TEXT NOT NULL
    )
  `;
});
