import { SqlClient } from "effect/unstable/sql";
import { Effect } from "effect";

/**
 * Adds the global Pokémon collection plus a nullable worktree link. Kept
 * recoverable because early developer databases may already have partial
 * columns/tables from branch testing.
 */
export const Migration0018PokemonWorktrees = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const worktreeColumns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(worktrees)
  `;
  const hasWorktreeColumn = (name: string): boolean =>
    worktreeColumns.some((column) => column.name === name);

  if (!hasWorktreeColumn("pokemon_number")) {
    yield* sql`
      ALTER TABLE worktrees
        ADD COLUMN pokemon_number INTEGER
    `;
  }

  yield* sql`
    CREATE TABLE IF NOT EXISTS pokemon_unlocks (
      pokemon_number INTEGER PRIMARY KEY,
      worktree_id TEXT REFERENCES worktrees(id) ON DELETE SET NULL,
      unlocked_at TEXT NOT NULL
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_pokemon_unlocks_worktree
      ON pokemon_unlocks(worktree_id)
  `;
});
