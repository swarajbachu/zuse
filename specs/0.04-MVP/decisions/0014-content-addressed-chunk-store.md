# ADR 0014 — Content-addressed chunk store + per-branch manifest

Date: 2026-05-06
Status: Accepted

## Context

Memoize's value prop is **N parallel
agent workspaces on the same repo** — multiple branches checked out
side-by-side, multiple agents iterating in parallel. Existing code-index
products (Cursor, Sourcegraph Cody, Greptile, Continue, Augment) struggle
here: they either re-index per branch (slow, expensive, redundant) or
share one stale index across branches (wrong file contents on the branch
the agent is actually on).

A typical scenario:

- User has 5 parallel workspaces open against the same repo
- Each workspace is on a different branch with 95% file overlap
- Naive per-branch indexing: 5× the storage, 5× the parsing, 5× the
  embedding API spend
- Naive shared index: agents searching from workspace B get results from
  whatever branch was last indexed

Both are bad. We need an architecture where:

- The 95% common file content is stored once
- Per-branch views are cheap to build and cheap to switch
- File edits in one workspace don't invalidate other workspaces
- Branch switches happen in milliseconds, not minutes

Git solved this exact problem decades ago: blobs are content-addressed by
SHA, and a tree object maps paths to blob SHAs. Switching branches is
swapping the active tree, not rewriting blobs. We adopt the same shape.

## Decision

Store all parsed content in a **content-addressed blob store**, with
**per-branch manifests** that map file paths to blob hashes for a given
branch.

### Schema (one SQLite file per workspace)

```sql
blobs (
  id          INTEGER PRIMARY KEY,
  sha         BLOB NOT NULL UNIQUE,    -- blake3 of file content
  language    TEXT,
  size        INTEGER NOT NULL,
  parsed_at   INTEGER
);

chunks (
  id          INTEGER PRIMARY KEY,
  blob_id     INTEGER NOT NULL REFERENCES blobs(id),
  kind        TEXT NOT NULL,
  start_line  INTEGER NOT NULL,
  end_line    INTEGER NOT NULL,
  symbol_id   INTEGER REFERENCES symbols(id),
  content     TEXT NOT NULL
);

symbols (
  id          INTEGER PRIMARY KEY,
  blob_id     INTEGER NOT NULL,
  name        TEXT NOT NULL,
  kind        TEXT NOT NULL,
  signature   TEXT,
  start_line  INTEGER, end_line INTEGER,
  parent_id   INTEGER REFERENCES symbols(id),
  exported    INTEGER NOT NULL DEFAULT 0
);

manifests (
  branch       TEXT NOT NULL,
  file_path    TEXT NOT NULL,
  blob_id      INTEGER NOT NULL,
  PRIMARY KEY (branch, file_path)
);
CREATE INDEX manifests_blob ON manifests(blob_id);
```

### Why blake3 (not sha256)

- ~3× faster on small files than sha256
- 256-bit, collision-resistant
- Native module is small, well-maintained
- We're computing a SHA per file on every save — speed adds up

### Branch switch algorithm

```
diff = manifests[from_branch] symmetric_difference manifests[to_branch]
for (path, old_blob, new_blob) in diff:
  if new_blob is None: delete manifests[to_branch][path]   # file removed
  else:                upsert manifests[to_branch][path] = new_blob
emit "branch_switched"  →  router rebinds queries to the new branch
```

No re-parsing for unchanged blobs. Storage cost: one row per (branch,
path) pair, plus the deduped blobs themselves.

### Garbage collection

A blob is GC-eligible when no manifest references it. Run a periodic GC
that deletes orphaned blobs (and their chunks/symbols/embeddings).

```sql
DELETE FROM blobs WHERE id NOT IN (SELECT DISTINCT blob_id FROM manifests);
```

Triggered on idle, or explicitly via `index.gc` RPC.

### Workspace sharing

One blob store per **repo identity** (`git rev-parse --show-toplevel` on
the original clone), not per workspace. Parallel workspaces on the same
repo share the underlying blob store; each workspace contributes a
manifest keyed by branch. Five workspaces on five branches = one blob
store, five manifest sets.

The DB file lives at:

```
<userData>/index/<repo-id>/memoize-index.sqlite
```

`<repo-id>` is `blake3(absolute_path_of_origin_clone)` — stable across
parallel workspaces of the same repo.

## Consequences

### Positive

- 5 parallel workspaces on the same repo: 1× storage, not 5×.
- Branch switch < 200ms target is achievable (manifest swap is a SQL
  transaction over a few hundred rows).
- File edits invalidate only the changed blob — embeddings, symbols,
  chunks for unchanged blobs persist.
- Symmetric difference between branches gives us "what changed" cheaply,
  reusable for future features (incremental review, diff-aware retrieval).
- Cloud sync (deferred Phase G) is straightforward: blobs are already
  content-addressed; sync becomes "push blobs missing on remote, push
  manifest deltas."

### Negative

- Manifest table can grow large on repos with many branches and many
  files. Mitigation: index on `branch` and `blob_id`; VACUUM periodically.
- GC complexity: have to be careful not to delete blobs still referenced
  by checked-out worktrees. Mitigation: GC only on idle, with explicit
  manifest scan first.
- Adds blake3 native module (one more rebuild target).

## Alternatives considered

### Per-branch SQLite files

- Pro: simpler mental model.
- Con: 5× storage and parsing. Branch switch means switching DB
  connections. Doesn't dedupe.

### Single index, branch as a column on every row

- Pro: simpler schema.
- Con: every query needs a `WHERE branch = ?` filter. Indexes get
  bloated. No deduplication.

### File modtime as the dedup key

- Pro: cheaper than hashing.
- Con: modtime changes when you `touch` a file; dedup breaks. Hashing is
  cheap with blake3 — pay it.

### Reuse git's own object store

- Pro: free dedup.
- Con: requires the user's repo to be a git repo (memoize supports
  non-git folders too); requires reading git internals; memoize would
  have a hard time managing untracked / generated files.

## What we deliberately rejected

- Storing chunks per branch instead of per blob. Chunks are deterministic
  on blob content; deriving them from blob_id is the right shape.
- Sharing blob stores across repos. Blob hash collision across different
  codebases is astronomical, but the conceptual confusion isn't worth
  the savings.
- A pure git-tree-walking strategy that skips the manifest table. We
  need to support non-git directories and untracked files.
