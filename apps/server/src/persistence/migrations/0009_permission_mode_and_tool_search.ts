import { SqlClient } from "effect/unstable/sql";
import { Effect } from "effect";

/**
 * Adds two SDK-lifecycle fields to `sessions`:
 *
 *   - `permission_mode` — Claude SDK's `Options.permissionMode`. Distinct
 *     from `runtime_mode` (our own auto-allow policy). `'plan'` means the
 *     agent is restricted to read-only tools and is expected to call the
 *     SDK's built-in `ExitPlanMode` to propose a plan.
 *   - `tool_search` — when 1, future MCP servers register without
 *     `alwaysLoad`, so the SDK delegates to its built-in tool search
 *     instead of inflating the prompt with every tool schema. No-op today
 *     (no MCP tools shipped yet); reserved for the 0.04 code-index.
 *
 * Existing rows default to `'default'` / `0` — same behavior as before.
 */
export const Migration0009PermissionModeAndToolSearch = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    ALTER TABLE sessions
    ADD COLUMN permission_mode TEXT NOT NULL DEFAULT 'default'
  `;
  yield* sql`
    ALTER TABLE sessions
    ADD COLUMN tool_search INTEGER NOT NULL DEFAULT 0
  `;
});
