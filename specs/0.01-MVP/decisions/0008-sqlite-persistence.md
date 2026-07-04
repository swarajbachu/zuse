# ADR 0008 — SQLite + @effect/sql for persistence

Date: 2026-05-03
Status: Accepted

## Context

Phase 3 introduces persisted projects, sessions, and messages. We need:

- A real database (sessions and messages can grow into thousands of rows; JSON blobs don't scale).
- Effect-shaped DI so persistence is just another Layer alongside `WorkspaceService`, `ProviderService`, etc.
- Migrations we can ship and never break.
- Single-file portability — the user can back up or `sqlite3` into the data.
- Server-side only — renderer never reads the DB directly (preserves ADR 0007's transport seam).

## Decision

Use **SQLite** as the storage engine and **`@effect/sql-sqlite-node`** as the client, with **`@effect/sql/Migrator`** for schema evolution. Database file at `<userData>/zuse.sqlite`. All access goes through repository Layers in `apps/server/src/persistence/`.

### Why SQLite

- Zero-config, single file, fast for local desktop use.
- Universal tooling (`sqlite3`, DataGrip, etc.) — users can inspect their own data.
- No server process to manage.
- Native module is already an accepted cost (we ship `keytar` and `node-pty` which need electron-rebuild; SQLite joins them).

### Why `@effect/sql-sqlite-node` over alternatives

- **Drizzle / Kysely:** Excellent libraries, but layering them under Effect means writing a wrapper. `@effect/sql` already speaks Effect natively (`SqlClient`, `SqlSchema.findOne`, etc.) and the `Migrator` is integrated.
- **Raw `better-sqlite3`:** Too low-level. We'd reinvent migrations, query helpers, and DI.
- **`@effect/sql-sqlite-bun`:** Right shape, wrong runtime — Electron's main process is Node, not Bun.

### Why migrations as numbered SQL files

- Same pattern the reference codebase uses; battle-tested.
- One migration per schema change, never edit a shipped migration.
- `effect_sql_migrations` table tracks applied migrations automatically.

### Native module rebuild

`@effect/sql-sqlite-node` depends on `better-sqlite3` (or `node:sqlite` on Node ≥22.16 — we lock to `better-sqlite3` for Electron compatibility). Add it to the existing `electron-rebuild -w` list alongside `keytar` and `node-pty`.

## Consequences

### Positive
- Persistence becomes an ordinary Effect Layer.
- Type-safe queries via `SqlSchema`.
- Schema migrations are explicit and reviewable in PRs.
- DB file is portable and inspectable.

### Negative
- Adds another native module to the rebuild pipeline.
- Migrations require discipline — once shipped, a migration can't be edited, only superseded.
- Effect SQL has a learning curve for contributors who haven't seen it.

## Alternatives considered

- **JSON files per project.** Considered for the MVP; rejected because session message lists grow unbounded and atomic updates over JSON are a pain.
- **PostgreSQL via Docker.** Overkill for a single-user desktop app.
- **IndexedDB in the renderer.** Breaks ADR 0007 (renderer can't be the source of truth if a CLI client wants the same data later).

## Reference

The pattern mirrors the persistence layer in mature Effect codebases: repository Layers expose typed methods, `SqlClient` is provided once at the top of the Layer graph, migrations live under `apps/server/src/persistence/migrations/`. This is the same shape ADR 0007 already enables for the server-as-code-only app.
