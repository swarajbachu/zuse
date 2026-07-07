# ADR 0019 — SQLite + sqlite-vec for vector search (extends ADR 0008)

Date: 2026-05-06
Status: Accepted

## Context

ADR 0008 established SQLite + `@effect/sql-sqlite-node` (with
`better-sqlite3`) as memoize's persistence engine. 0.04 adds vector
search to the index. Three places that vector storage could live:

- A separate vector DB (LanceDB, Qdrant, Chroma, Weaviate)
- A SQLite extension that adds vector columns
- An in-memory index (FAISS, hnswlib) backed by serialized files

The memoize principles (ADR 0007: server is the only source of truth;
ADR 0008: single-file portability; local-first) point at "stay inside
SQLite if at all possible." Adding a second persistence engine adds a
second backup story, a second failure mode, a second startup
dependency. Avoid.

`sqlite-vec` is a SQLite extension by Alex Garcia (also author of
sqlite-utils ecosystem tools, very actively maintained). It adds:

- A `vec0` virtual table type for dense vectors
- KNN search via `MATCH` syntax
- Integer quantization for compression
- ~5MB native binary, distributable via npm
- Battle-tested in production (used by Datasette, several Cursor-like
  IDEs, and recent versions of Open WebUI)

Performance: KNN search over 100k 768-dim vectors is ~5-20ms on a
modern laptop. That's comfortably inside our Tier 3 latency budget
(rerank dominates at 100-300ms).

## Decision

Use **`sqlite-vec`** as the vector storage engine. It plugs into the
existing SQLite database file via SQLite's extension loading API.

### Wiring

```ts
// packages/index/src/runtime.ts
import * as sqliteVec from "sqlite-vec"

const Database = yield* SqlClient.SqlClient
yield* Effect.sync(() => {
  const handle = (Database as any).rawDatabase  // exposed by @effect/sql-sqlite-node
  sqliteVec.load(handle)
})
```

### Schema

```sql
-- 768 dim default to match nomic-embed-code (the default embed model).
-- We store dim metadata so the engine refuses to mix models.
CREATE VIRTUAL TABLE chunk_vec USING vec0(
  chunk_id INTEGER PRIMARY KEY,
  embedding FLOAT[768]
);

-- A separate table stores which model produced the embeddings.
-- If the user switches embed model, we throw on inconsistent dims and
-- offer a "reindex embeddings" path.
CREATE TABLE embedding_meta (
  model     TEXT PRIMARY KEY,
  dim       INTEGER NOT NULL,
  created   INTEGER NOT NULL
);
```

### Native module rebuild

`sqlite-vec` ships prebuilt binaries via npm. For Electron, we add it
to the existing `electron-rebuild -w` list alongside `keytar`,
`node-pty`, `better-sqlite3`, and the new tree-sitter / blake3 /
@parcel/watcher modules.

### Catalog entry

```json
"sqlite-vec": "catalog:"
```

Per ADR 0006, native modules used by 2+ workspaces (here, `apps/server`
and `apps/mcp-server` via `@zuse/index`) are catalogued.

### Embedding lifecycle

- New chunks are inserted with no embedding (`embedding IS NULL` in
  `chunk_vec` is *not* possible — we omit the row entirely).
- The async embedding worker pulls chunks lacking a vec row, embeds
  them in batches of 64, inserts into `chunk_vec`.
- Search queries gracefully handle chunks missing embeddings —
  `vec0` returns only chunks with embeddings; BM25 still searches all
  chunks; fusion combines.

### Migrations

`sqlite-vec` virtual tables are created in numbered SQL migration files
following the ADR 0008 pattern:

```
packages/index/src/schema/migrations/
  0001-init.sql              # base tables
  0002-add-chunk-vec.sql     # vec0 virtual table
  0003-add-embedding-meta.sql
```

Migrations are run via `@effect/sql/Migrator` at engine startup.

## Consequences

### Positive

- One file, one backup story. The user's index lives in their
  workspace's `memoize-index.sqlite`.
- Same query engine for vector + BM25 + symbol — joins across them are
  trivial (`JOIN chunks ON chunks.id = chunk_vec.chunk_id`).
- Schema migrations follow the existing ADR 0008 pattern; no new
  migration tooling.
- `vec0` performance is good enough: KNN over 100k chunks in 5-20ms.
- Active maintenance + community.

### Negative

- One more native module in the rebuild pipeline. Not free, but
  marginal cost on top of what we already maintain.
- `sqlite-vec` is younger than the SQLite core. Treat new releases
  with caution; pin the version explicitly.
- Vector quantization (the int8 / int4 features) is on the cutting
  edge — we don't enable it in v1; revisit if storage becomes a
  problem.

## Alternatives considered

### LanceDB (separate file/process)

- Pro: best-in-class vector engine, growing momentum.
- Con: separate persistence engine, separate backup story, second DB
  to manage. Doesn't fit the "single-file portability" principle of
  ADR 0008.

### Qdrant / Chroma / Weaviate (server)

- Pro: full vector DB.
- Con: server process to run. Overkill for desktop, hostile to
  local-first.

### FAISS / hnswlib in-memory + serialize on disk

- Pro: fastest vector search at small-to-medium scale.
- Con: two stores to keep in sync (SQLite for metadata, hnswlib for
  vectors). Crash recovery is complex. Not worth the speed gain at our
  scale.

### Pure SQLite + cosine similarity in SQL

- Pro: no extension required.
- Con: SQLite has no native dot-product. Computing cosine in SQL means
  a full scan; doesn't scale beyond a few thousand chunks.

## What we deliberately rejected

- Multiple embedding models per workspace. One model per workspace,
  enforced by `embedding_meta`. Switching models requires re-embed.
- Storing raw vectors as TEXT/BLOB in `chunks` and computing similarity
  manually. The right abstraction is `vec0`.

## Reference

`sqlite-vec` repo: github.com/asg017/sqlite-vec. ADR 0008 establishes
SQLite + `@effect/sql-sqlite-node` as the persistence baseline that
this ADR extends.
