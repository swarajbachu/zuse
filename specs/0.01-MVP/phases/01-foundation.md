# Phase 1 — Foundation

**Goal**: a usable single-user MVP. Pick a folder, run a real shell in it, see the git log of that folder live-updating.

**Status**: 📐 Spec

**Estimate**: ~4 weeks

## Deliverables

1. Folder sidebar with persistence
2. PTY-backed terminal pane (one terminal per active folder)
3. Live git history pane
4. Effect runtime + Layer architecture established in both processes
5. Typed IPC contracts package

## Out of scope (deferred)

- Multiple terminals per folder (Phase 4)
- Agent integration (Phase 2)
- Permission prompts (Phase 3)
- Diff viewer (Phase 4)

## User scenarios

### S1 — First launch
> I open the app for the first time. The sidebar is empty with a `+` button and a hint "Add a folder to begin." I click `+`, the OS folder picker opens, I pick `~/code/myproject`. The folder appears in the sidebar, automatically selected. The center pane is a shell with `~/code/myproject` as cwd. The right pane shows the last 50 commits.

### S2 — Restart
> I quit and reopen. My folder list is preserved. The previously active folder is restored. The terminal starts fresh; it does not try to reattach to the old PTY.

### S3 — Switch folder
> I have three folders. I click another. The center terminal is replaced with a new shell in that folder. The git pane reloads. The previous folder's terminal is killed.

### S4 — Live git
> I run `git commit` in the terminal. Within ~1s, the new commit appears at the top of the right pane.

## Architecture decisions for this phase

- **One terminal per folder.** Simpler state. Multi-tab is Phase 4.
- **No background folders.** Switching folders kills the previous PTY. Avoids resource leaks before we have UI for it.
- **Polling, not fs-watch, for git.** Poll `git log -1 --format=%H` every 2s on the active folder. Only re-fetch full log when HEAD changes. Cheap, robust, no native dependencies.
- **PTY scrollback not persisted** in this phase. Phase 3 adds it.

## IPC contracts (in `packages/contracts/`)

```ts
// workspace.ts
export const WorkspaceFolder = Schema.Struct({
  id: Schema.String,             // stable hash of path
  path: Schema.String,           // absolute
  name: Schema.String,           // display name (basename by default)
  addedAt: Schema.Date,
})

// pty.ts
export const PtyOpenInput = Schema.Struct({
  folderId: Schema.String,
  cols: Schema.Number.pipe(Schema.between(1, 1000)),
  rows: Schema.Number.pipe(Schema.between(1, 500)),
})
export const PtyOutputEvent = Schema.Struct({
  ptyId: Schema.String,
  chunk: Schema.String,          // utf-8
})
export const PtyExitedEvent = Schema.Struct({
  ptyId: Schema.String,
  code: Schema.Number,
  signal: Schema.optional(Schema.String),
})

// git.ts
export const GitCommit = Schema.Struct({
  sha: Schema.String,
  shortSha: Schema.String,
  subject: Schema.String,
  authorName: Schema.String,
  authoredAt: Schema.Date,
  parents: Schema.Array(Schema.String),
})
export const GitStatusSummary = Schema.Struct({
  branch: Schema.optional(Schema.String),
  ahead: Schema.Number,
  behind: Schema.Number,
  dirtyFiles: Schema.Number,
})
```

## IPC channels

| Channel | Direction | Input | Output |
|---|---|---|---|
| `workspace:list` | renderer → main | none | `WorkspaceFolder[]` |
| `workspace:add` | renderer → main | `{ path }` | `WorkspaceFolder` |
| `workspace:remove` | renderer → main | `{ id }` | `void` |
| `workspace:pickFolder` | renderer → main | none | `string \| null` (cancelable) |
| `pty:open` | renderer → main | `PtyOpenInput` | `{ ptyId }` |
| `pty:write` | renderer → main | `{ ptyId, data }` | `void` |
| `pty:resize` | renderer → main | `{ ptyId, cols, rows }` | `void` |
| `pty:close` | renderer → main | `{ ptyId }` | `void` |
| `pty:output` | main → renderer (stream) | `{ ptyId }` | stream of `PtyOutputEvent` |
| `pty:exited` | main → renderer (stream) | `{ ptyId }` | `PtyExitedEvent` |
| `git:log` | renderer → main | `{ folderId, limit }` | `GitCommit[]` |
| `git:status` | renderer → main | `{ folderId }` | `GitStatusSummary` |
| `git:headChanged` | main → renderer (stream) | `{ folderId }` | `{ sha }` |

## Critical files to create / modify

- **Modify**: `apps/desktop/src/main.ts` — wire `IpcHandlersLayer` into app boot
- **Modify**: `apps/desktop/src/preload.ts` — typed bridge for all channels above
- **Create**: `apps/desktop/src/runtime.ts` — Layer composition for main process
- **Create**: `apps/desktop/src/services/pty/` — `PtyService` Effect Layer
- **Create**: `apps/desktop/src/services/git/` — `GitService` Effect Layer
- **Create**: `apps/desktop/src/services/workspace/` — `WorkspaceService` Effect Layer
- **Create**: `apps/desktop/src/ipc/channels.ts` — channel registration table
- **Create**: `apps/desktop/src/ipc/handlers.ts` — Layer that registers handlers
- **Create**: `packages/contracts/` — new package with all schemas above
- **Modify**: `apps/renderer/src/components/sidebar.tsx` — wire to `workspace:*`
- **Modify**: `apps/renderer/src/components/terminal-pane.tsx` — replace local echo with PTY
- **Modify**: `apps/renderer/src/components/git-history-pane.tsx` — replace mock with `git:log`
- **Create**: `apps/renderer/src/runtime.ts` — renderer Effect runtime
- **Create**: `apps/renderer/src/store/workspace.ts` — Zustand store
- **Create**: `apps/renderer/src/lib/desktop.ts` — typed IPC client (extend existing)

## Acceptance criteria

- [ ] Cold-start to terminal-prompt under 2s on M-series
- [ ] All four user scenarios above pass manually
- [ ] `bun run typecheck` clean across all packages
- [ ] Killing a PTY (close folder, quit app) leaves no orphaned `node-pty` processes (verify with `ps`)
- [ ] Workspace list survives app restart
- [ ] No `any` in IPC contract files
- [ ] Effect Layer composition lives in one place per process; no `Effect.runPromise` calls outside the runtime entry points

## Verification

1. `bun install && bun run dev` launches the Electron app
2. Click `+`, pick a real folder — folder appears in sidebar
3. Quit, relaunch — folder still there
4. Type `ls`, `pwd`, `git status` in the terminal; output renders correctly with colors
5. Right pane shows the actual `git log` output for the folder
6. Run `git commit --allow-empty -m "test"` in the terminal — new commit appears at top within 2s
7. `ps aux | rg node-pty` after app quit returns nothing

## Risks

- **Effect learning curve.** Mitigation: Phase 1 uses Effect for service definition + Layer wiring + Schema. Effect RPC (`@effect/rpc`) is wired from day 1 via a custom `RpcServer.Protocol` / `RpcClient.Protocol` over Electron IPC, so streaming RPCs (PTY output, git events) need no extra plumbing later.
- **node-pty native build issues.** Mitigation: pin Electron version; use `electron-rebuild` in postinstall.
- **Vite + Electron preload sandboxing gotchas.** Mitigation: keep preload minimal; do all logic in main.
