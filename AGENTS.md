# Agent Notes

## SQLite Changes

- Avoid SQL column names that are SQLite keywords, common SQL function names, or parser-sensitive words. In particular, do not use names like `position`, `order`, `index`, `table`, `group`, `default`, or `references` as unquoted columns.
- Prefer explicit, domain-specific names such as `queue_order`, `display_order`, `sort_rank`, or `sequence_number`.
- When changing SQLite migrations or query SQL, verify with the production SQLite driver when possible. Bun's `bun:sqlite` test client can accept statements that the packaged Node/Electron `better-sqlite3` path later rejects with `Failed to prepare statement`.
- If a migration may have partially run before failing, make the follow-up migration idempotent and recoverable: inspect `PRAGMA table_info(...)`, add missing columns conditionally, and copy data forward from any legacy column names.
- Never rely on editing a numbered migration after it may have run on a developer machine or user database. The migrator records applied ids, so edited bodies are skipped. Add the next numbered repair migration instead, and cover the partially-applied/bad-schema state in a test.
- When running multiple app instances from different worktrees, use a separate `ZUSE_USER_DATA_DIR` per worktree. Otherwise those instances share one `zuse.sqlite`, and different code versions can race migrations or prepare SQL against a schema another instance has not migrated yet.
- Keep public TypeScript/wire field names stable when only the database column needs to change. Map database-safe names like `queue_order` back to UI/API names like `position` in row conversion helpers.
