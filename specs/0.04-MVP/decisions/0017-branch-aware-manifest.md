# ADR 0017 — Branch-aware manifest model

Date: 2026-05-06
Status: Accepted

## Context

ADR 0014 established the content-addressed blob store and per-branch
manifest schema. This ADR locks in the *operational* contract: when does
the manifest update, how does branch detection happen, what's the
expected switch latency, and what guarantees do we make under
concurrent agent activity.

The parallel-workspace pattern raises specific cases:

- Workspace A is on `main`, agent is mid-stream issuing `code_search`.
  Workspace B switches its branch. A's queries must continue against
  `main`, not bleed into B's branch.
- A user runs `git checkout` from the right-pane terminal (Phase 2's
  PTY). The index needs to detect this and update the active branch
  for that workspace.
- A user creates a new branch with `git checkout -b foo`. The new branch
  inherits the current manifest (it's the same tree at creation time).
- A 1000-file branch switch shouldn't block the agent for seconds.

## Decision

### Per-workspace active branch

Each memoize workspace tracks its own *active branch* in memory.
`IndexService.search` accepts a `branch?` param; when omitted, it uses
the workspace's active branch. Workspace A's queries never see B's
manifest, even though both share the underlying blob store.

```ts
// apps/server/src/index/index-service.ts
class IndexService {
  search(input: SearchInput, ctx: WorkspaceContext) {
    const branch = input.branch ?? ctx.activeBranch
    return engine.search({ ...input, branch })
  }
}
```

### Branch detection

Two sources of truth, in priority order:

1. **Explicit RPC** — `index.setBranch(branch: string)` from the
   renderer when the workspace UI changes branch. Authoritative when
   present.
2. **Git watcher** — watches `<workspace>/.git/HEAD` (a tiny file that
   changes on every checkout). On change, parse it, update active
   branch, kick off manifest reconciliation.

We do **not** parse PTY output to detect `git checkout`. That's
fragile (custom shells, aliases, output formatting). The `.git/HEAD`
watch is reliable.

### Manifest reconciliation

When the active branch changes from `from` to `to`:

```
1. compute walk(workspace, to_branch)
   → emit (path, blob_sha) for each file in working tree
2. for each (path, sha):
     blob = upsert blobs(sha, ...)         -- inserts if new
     if new blob:
       parse, chunk, extract symbols, enqueue embeddings
     upsert manifests(to_branch, path, blob.id)
3. delete manifests(to_branch, path) for paths no longer present
4. activeBranch[workspace] = to
5. fire IndexBranchSwitched event (renderer can refresh search UI)
```

Steps 2–3 happen in one SQL transaction. New blobs that need parsing
happen *after* the transaction commits — the manifest swap doesn't wait
for parsing/embedding.

### Latency contract

| Scenario | Target |
|---|---|
| Manifest swap (no new blobs) | < 50ms |
| Branch switch with ~10 changed files | < 200ms |
| Branch switch with 1000 changed files | < 1s for manifest, parsing async |
| File edit → re-index | < 50ms |

We do **not** block agent queries during reconciliation. Mid-flight
queries against `from_branch` complete against `from_branch`'s manifest.
New queries arriving after the swap see `to_branch`. Stale results from
a query started before the swap are accepted — agents handle this fine.

### Untracked and ignored files

- `.gitignore` is respected by default
- An `index-ignore` file at the workspace root can extend ignores
- Generated files (e.g., `dist/`) are excluded by default ignores
- Untracked files **are indexed** (the agent should see new files the
  user is working on). They live in the manifest under the active
  branch even though git doesn't track them.

### New branches

`git checkout -b foo` from `main`: the watcher fires; reconciliation
walks the working tree (which is identical to `main` at creation); the
new manifest gets the same blob_ids as `main`. Net new rows in
`manifests` only — no re-parsing.

### Concurrent workspaces

Two parallel workspaces (A on `main`, B on `feature`) run agents in
parallel. Each writes its own `(branch, path, blob_id)` rows. SQLite's
default WAL mode handles the concurrency. Reads are non-blocking.

## Consequences

### Positive

- Branch switches feel instant in UI even on huge changesets.
- Parallel workspaces don't step on each other.
- Detection is reliable (file watcher on `.git/HEAD` is bulletproof).
- The agent always sees its workspace's branch, never bleeds.

### Negative

- File watcher overhead per workspace. With 5 parallel workspaces, 5
  `.git/HEAD` watches plus 5 working-tree watches. `@parcel/watcher`
  handles this fine, but we should profile.
- Stale-result tolerance for in-flight queries during a swap. Documented
  as acceptable; agents handle it. If users report weirdness, we can
  add per-query branch capture as a tightening.

## Alternatives considered

### Re-index on every branch switch

- Pro: simplest code.
- Con: violates the < 200ms target. Defeats the parallel-workspace
  value prop.

### Branch as a label on chunks (no manifest table)

- Pro: simpler schema.
- Con: every query needs a `WHERE branch = ?` filter. Can't dedupe
  cross-branch.

### Detect branch by parsing PTY output

- Pro: works without git internals.
- Con: fragile across shells, aliases, custom prompts. Discarded.

### Use libgit2 / nodegit

- Pro: rich git API.
- Con: heavy native dependency for one feature. Watching `.git/HEAD`
  + a small wrapper around `git rev-parse HEAD` is enough.

## What we deliberately rejected

- Blocking agent queries during reconciliation.
- Cross-workspace branch sharing (each workspace has its own active
  branch by design).
- A unified "current branch" — the product model is built around parallelism.
