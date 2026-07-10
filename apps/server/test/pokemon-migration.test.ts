import { describe, expect, it } from "vitest";
import { SqlClient } from "effect/unstable/sql";
import { SqliteClient } from "@effect/sql-sqlite-bun";
import { Effect, ManagedRuntime } from "effect";

import { Migration0018PokemonWorktrees } from "../src/persistence/migrations/0018_pokemon_worktrees.ts";

describe("Migration0018PokemonWorktrees", () => {
  it("is idempotent on a pre-Pokémon worktree schema", async () => {
    const SqlLive = SqliteClient.layer({ filename: ":memory:" });
    const runtime = ManagedRuntime.make(SqlLive);
    try {
      await runtime.runPromise(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* sql`
            CREATE TABLE projects (
              id TEXT PRIMARY KEY
            )
          `;
          yield* sql`
            CREATE TABLE worktrees (
              id TEXT PRIMARY KEY,
              project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
              path TEXT NOT NULL,
              name TEXT NOT NULL,
              branch TEXT NOT NULL,
              base_branch TEXT NOT NULL,
              created_at TEXT NOT NULL,
              UNIQUE(project_id, path)
            )
          `;
          yield* Migration0018PokemonWorktrees;
          yield* Migration0018PokemonWorktrees;

          const columns = yield* sql<{ readonly name: string }>`
            PRAGMA table_info(worktrees)
          `;
          const unlocks = yield* sql<{ readonly name: string }>`
            SELECT name
            FROM sqlite_master
            WHERE type = 'table' AND name = 'pokemon_unlocks'
          `;

          expect(
            columns.some((column) => column.name === "pokemon_number"),
          ).toBe(true);
          expect(unlocks).toHaveLength(1);
        }),
      );
    } finally {
      await runtime.dispose();
    }
  });
});
