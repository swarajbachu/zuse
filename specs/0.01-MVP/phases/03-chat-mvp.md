# Phase 3 — Chat-first MVP

Status: ✅ Shipped

## Goal

Replace memoize's terminal-first UI shell with a three-pane chat IDE. By the end of Phase 3 a user can: pick a project from the left sidebar, open a chat session, send messages with markdown rendering, watch tool calls expand inline, browse the project's file tree on the right, and run shell commands in a side terminal. Sessions persist across app restart and can be archived.

The backend shipped in Phase 2 (provider adapters, credentials, `agent.events` stream) is reused unchanged. What changes is: persistence, layout, the chat surface, and dropping the launcher / git pane.

## Layout

```
┌────────────────┬────────────────────────────────┬──────────────────┐
│  Projects      │  Chat                          │  Files / Terminal│
└────────────────┴────────────────────────────────┴──────────────────┘
```

Three resizable columns. Left and right are collapsible (≥768px width threshold). Center is always visible.

### Left — projects + sessions

- Project list (today's "folders"). `+ New project` opens the OS folder picker.
- Each project expands to show its sessions, ordered by `updatedAt` desc.
- Sessions: title (auto-generated from first user message, editable), `archived` flag (archived sessions hidden behind a toggle), `+ New session` button per project.
- Right-click / long-press on a session: rename, archive, delete.
- Selecting a session loads its message history into the center pane.

### Center — chat

- Message timeline (scrollable, auto-scroll on new message unless user has scrolled up).
- Roles: `user` (right-aligned), `assistant` (left-aligned), `tool` (inline collapsible blocks within the assistant's turn).
- Markdown + code blocks rendered (`react-markdown` + `shiki` for syntax highlighting).
- Tool calls render as expandable rows: header shows tool name + one-line summary, expanded shows JSON input + output.
- `edit_file` tool calls render a unified diff (Phase 4 polish; Phase 3 ships the JSON view first).
- Composer at the bottom: textarea + model picker dropdown + send button. `Cmd/Ctrl+Enter` sends.
- Composer disabled while a turn is in flight; an "Interrupt" button replaces send during a turn.

### Right — files + terminal (tabbed)

- **Files tab.** Read-only file tree of the project. Lazy-load directories. Click a file → preview in a sheet (Phase 3 ships file path + size; full preview is Phase 4 polish).
- **Terminal tab.** Reuses Phase 1's PTY service. One terminal per project, persisted across session switches within the same project.
- Tab bar at top of the right pane. Pane is collapsible.

## Persistence

SQLite via `@effect/sql-sqlite-node` + `@effect/sql/Migrator`. Database file at `<userData>/zuse.sqlite`. See [ADR 0008](../decisions/0008-sqlite-persistence.md) for the full rationale.

### Schema (initial migration)

```sql
-- projects: a folder the user has added to memoize.
CREATE TABLE projects (
  id TEXT PRIMARY KEY,                 -- existing FolderId from Phase 1
  path TEXT NOT NULL,
  name TEXT NOT NULL,
  default_model TEXT,                  -- last model used, restored on new session
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- sessions: one chat thread within a project.
CREATE TABLE sessions (
  id TEXT PRIMARY KEY,                 -- AgentSessionId
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  provider_id TEXT NOT NULL,           -- "claude" | "codex"
  model TEXT NOT NULL,                 -- e.g. "claude-opus-4-7"
  status TEXT NOT NULL,                -- "idle" | "running" | "closed" | "error"
  archived_at TEXT,                    -- NULL = active
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_sessions_project ON sessions(project_id, archived_at, updated_at DESC);

-- messages: user/assistant turns, plus inline tool-call rows.
CREATE TABLE messages (
  id TEXT PRIMARY KEY,                 -- AgentItemId (or new MessageId)
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  role TEXT NOT NULL,                  -- "user" | "assistant" | "tool"
  kind TEXT NOT NULL,                  -- "text" | "tool_use" | "tool_result" | "error"
  content_json TEXT NOT NULL,          -- shape varies by kind
  created_at TEXT NOT NULL
);
CREATE INDEX idx_messages_session ON messages(session_id, created_at);
```

Schema changes ship as numbered migrations under `apps/server/src/persistence/migrations/`. We never edit a shipped migration; we add a new one.

### How events become rows

The Phase 2 `AgentEvent` stream (over `agent.events` RPC) is consumed by a `MessageStore` service in the server. As events arrive, they're persisted to `messages` and re-broadcast to the renderer over the existing stream. The renderer never reads SQLite directly — it goes through RPCs, which means the WS-server extraction story still works.

## RPC additions

New methods (added to `MemoizeRpcs` in `packages/contracts`):

- `session.list(projectId, includeArchived)` → `Session[]`
- `session.create(projectId, providerId, model, initialPrompt?)` → `Session` (replaces `agent.start`)
- `session.rename(sessionId, title)`
- `session.archive(sessionId)` / `session.unarchive(sessionId)`
- `session.delete(sessionId)`
- `messages.list(sessionId)` → `Message[]` (cold-load history)
- `messages.stream(sessionId)` → `Stream<Message>` (live updates; renames `agent.events` and broadens it to include user messages)
- `fs.tree(projectId, path?)` → directory listing for the right-pane Files tab

`agent.start` / `agent.send` / `agent.interrupt` / `agent.close` stay; they become internal to `session.*` (renderer no longer calls them directly).

## What gets removed

- `apps/renderer/src/components/agent-launcher.tsx` (Cmd+K launcher) — replaced by `+ New session` button.
- `apps/renderer/src/components/agent-panel.tsx` — replaced by the chat surface.
- `apps/renderer/src/components/agent-event-row.tsx` — replaced by per-role chat rows.
- `apps/renderer/src/components/git-history-pane.tsx` — git history is no longer in the v1 UI. (Code lives in git history if we want to bring it back as a tab later.)
- `git.log` / `git.status` / `git.headChanged` / `git.origin` RPCs — kept in `packages/contracts` for now (cheap to keep) but unwired from the UI.

## Sub-PR breakdown

Seven PRs. Each independently shippable.

### PR 1 — SQLite + persistence scaffolding
- Add `@effect/sql` + `@effect/sql-sqlite-node` deps, write `apps/server/src/persistence/Sqlite.ts` (client + Migrator layer).
- Migration `001_initial.sql` with `projects`, `sessions`, `messages` tables.
- `ProjectRepository`, `SessionRepository`, `MessageRepository` Layers (CRUD; no business logic yet).
- DB file at `<userData>/zuse.sqlite`; `:memory:` flag for tests.
- No UI changes. Existing folders backfill into `projects` on boot.

### PR 2 — session RPCs + MessageStore
- Add `session.*` and `messages.*` RPCs to `@zuse/contracts`.
- `MessageStore` service: subscribes to `AgentEvent` stream from Phase 2, persists each event as a `messages` row, re-emits.
- Wire `session.create` to call existing `agent.start` internally.
- Old `agent.*` RPCs stay (still used by `MessageStore` internally).

### PR 3 — left sidebar (projects + sessions)
- New `components/projects-sidebar.tsx` — list projects, expand to sessions, `+ New session`, right-click menu (rename / archive / delete).
- Replace `folder-sidebar.tsx` content; keep the existing folder picker / persistence path.
- `store/sessions.ts` — Zustand store with `sessions` keyed by project, selected session, hydration via `session.list`.

### PR 4 — chat surface (center pane)
- New `components/chat-view.tsx` — message timeline + auto-scroll.
- New `components/chat-composer.tsx` — textarea + model picker + send/interrupt.
- New `components/message-row.tsx` — user / assistant / tool variants.
- `react-markdown` + `shiki` for rendering. No diff viewer yet.
- Hooks up `messages.list` for cold load + `messages.stream` for live.

### PR 5 — right pane (files + terminal tabs)
- New `components/right-pane.tsx` with tabs.
- `components/file-tree.tsx` — lazy-loading tree backed by `fs.tree` RPC.
- `fs.tree` server impl using `@effect/platform` `FileSystem` (skip `.git`, `node_modules`).
- Terminal tab: reuse existing `terminal-pane.tsx`.
- Drop `git-history-pane.tsx` from layout.

### PR 6 — model picker + per-session model persistence
- Add `model` field to `StartSessionInput` (wire) + `sessions.model` column.
- Renderer composer dropdown lists provider × model combinations (claude-opus-4-7, claude-sonnet-4-6, claude-haiku-4-5, gpt-5-codex, etc.).
- Default model: project's `default_model`, or last-used.

### PR 7 — polish + acceptance pass
- Auto-title sessions from first user message (truncate to 60 chars).
- Empty states: no projects, no sessions, missing API key, network error.
- Walk every Phase 3 acceptance criterion below; flip status to ✅ Shipped.

## Acceptance criteria

A1. Add a project. Open a session. Send a message. Assistant streams back; markdown renders; tool calls expand on click.

A2. Quit the app mid-conversation. Reopen. Project + session list intact. Selecting the session shows full history.

A3. Archive a session. It disappears from the default list; toggling "Show archived" shows it again. Unarchive restores.

A4. With both Claude and Codex API keys set, open the model picker — both providers and their models are listed. Switching model in the composer applies to the next message.

A5. Right pane Files tab: project tree renders. Click a folder, it expands.

A6. Right pane Terminal tab: PTY opens in project root. `pnpm dev` runs and streams output.

A7. Quit during an active turn. Reopen. Session shows up to the last persisted event with a "(interrupted)" marker. Sending again starts a new turn.

A8. Interrupt button: clicking it during a turn aborts it within ~500ms. The partial assistant message is preserved.

## Non-goals (deferred to Phase 4+)

- Permission prompts UI (still auto-deny in Phase 3)
- File preview / inline diff rendering
- Session search
- "Always allow X" memory
- NDJSON transcript export
