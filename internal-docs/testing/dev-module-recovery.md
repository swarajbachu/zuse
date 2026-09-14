# Development module recovery

The renderer restarts Vite's module graph and dependency optimizer after a settled
Git revision change. This covers checkout, merge, rebase, reset, and commit while
`bun dev` remains running. Linked worktrees and packed refs are supported. An
index/HEAD lock or an unfinished merge/rebase postpones the restart; two stable
revision samples coalesce ref updates. The HTTP server owns the watcher's lifetime,
including across successive Vite restarts. Electron and backend processes stay up.

Native development imports can reject with `Failed to fetch dynamically imported
module` without emitting `vite:preloadError`. React.lazy catches these rejections,
so an unhandled-rejection listener alone is also insufficient. The root React error
boundary, global rejection listener, and Vite preload listener share one recovery
budget. Recovery waits for Vite to respond before reloading the document. It tries
at most ten readiness probes and permits one reload per 30 seconds across documents.
It does not clear application storage or evaluate a second copy of React in place.

These paths are development-only. A persistent missing dependency, syntax error, or
ordinary React hook error still needs its own fix. If a merge changes dependencies,
run `bun install`. Do not routinely delete caches or local application data.

## Verification

- `bun run --filter renderer test:unit` includes import recovery, throttling,
  unavailable-server behavior, Git transaction handling, and worktree cleanup.
- `bunx vitest run apps/renderer/test/integration/vite-git-recovery.test.ts`
  verifies successive revision changes against a real Vite server.
- In a running development renderer, interrupt a lazy module request and confirm
  one window reload, then confirm a persistent failure does not loop.
- Switch Git revisions while the renderer is open. Look for
  `[zuse] Git revision changed; rebuilding the dev module graph.` and verify that
  the window reconnects. An unresolved merge/rebase should not trigger repeated
  restarts.
