# Vision

## What memoize is

A desktop app for working with coding agents (Claude Code, Codex) chat-first. You add a project to the sidebar, open a session, and chat with an agent that has full access to that project's files. The agent does the work; you review the diff. A file tree and a real terminal sit on the right so you can run `pnpm dev`, `tsc --noEmit`, or `ls` without leaving the app.

The mental model is closer to chat-first agent apps than VS Code. The chat is the canvas; the file tree and terminal are tools you reach for when needed.

## What memoize is not

- **Not an editor.** We don't own the editor surface. Open files in your editor of choice; memoize shows file contents inline in chat, but doesn't let you edit them in-app.
- **Not a terminal-first tool.** The terminal is on the right panel, available, but it's not the primary surface. If you want a terminal-first agent UX, use Claude Code or Codex CLI directly.
- **Not cloud.** Sessions, messages, credentials live on disk. No telemetry without opt-in.
- **Not multi-user / collaborative.** Single-user desktop tool.

## Target user

A developer who:
- Already pays for / uses Claude Code, Codex, or both
- Wants chat-first agent interaction (read assistant prose, expand tool calls inline) over a terminal stream
- Runs many projects, wants per-project session history that persists across restart, and wants to archive sessions instead of deleting them
- Needs a real terminal occasionally (run dev server, run a script, sanity-check a path) but doesn't live in it

## Principles

1. **Chat-first.** The center of the screen is a message timeline + composer. Tool calls render inline as collapsible blocks. Markdown + code is rendered, not raw.
2. **One project, many sessions.** Each project has a list of sessions (active + archived). Sessions persist; closing the app does not lose them.
3. **Local by default.** SQLite on disk, keychain for credentials, no telemetry without opt-in.
4. **Open formats.** Sessions and messages live in a SQLite database the user can read with `sqlite3`. Credentials in the OS keychain.
5. **One way to do each thing.** Resist configuration sprawl. Pick a default, document the why.
6. **Boring tech where possible.** Effect.ts + SQLite + React. No bespoke databases, no custom protocols.

## Layout (MVP)

```
┌────────────────┬────────────────────────────────┬──────────────────┐
│  Projects      │  Chat                          │  Files / Terminal│
│  └ Project A   │  ┌──────────────────────────┐  │  ┌─────────────┐ │
│    ├ session 1 │  │ assistant: Sure, I'll... │  │  │ src/        │ │
│    ├ session 2 │  │   ▸ tool: read_file …    │  │  │ ├ index.ts  │ │
│    └ archived  │  │   ▸ tool: edit_file …    │  │  │ └ …         │ │
│  └ Project B   │  │ user: actually, …        │  │  ├─────────────┤ │
│    └ session 1 │  └──────────────────────────┘  │  │ $ pnpm dev  │ │
│  + New project │  ┌──────────────────────────┐  │  │ Listening … │ │
│                │  │ [model: claude-opus-4.7]│  │  └─────────────┘ │
│                │  │ Type a message…         │  │                  │
│                │  └──────────────────────────┘  │                  │
└────────────────┴────────────────────────────────┴──────────────────┘
```

Left: workspace + sessions (persisted, archivable, "+ new session" button).
Center: chat timeline + composer. Composer has a model picker.
Right: tabbed pane — **Files** (read-only file tree of the project) and **Terminal** (a real PTY that opens in the project root). Right pane is collapsible.

## Non-goals (v1)

- In-app code editor / file editing
- Plugin / extension system
- Multiple windows / detachable panes
- Remote / SSH workspaces
- Cloud sync of sessions
- Collaboration / shared sessions
- Mobile / web client (architecture supports it post-1.0; not on the v1 roadmap)
