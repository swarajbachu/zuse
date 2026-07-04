# Zuse Alpha

A chat-first desktop app for developers who work with AI coding agents. Wraps Claude Code, Codex, Grok, Gemini, Cursor, and OpenCode in a persistent, project-aware interface — structured chat history, rich composer, file viewer, integrated terminal, git worktrees, and session management, all stored locally.

> macOS only. Requires at least one supported agent CLI installed.

---

## Supported agents

| Provider | CLI |
|---|---|
| Claude | `claude` |
| Codex | `codex` |
| Grok | `grok` |
| Gemini | `gemini` |
| Cursor | `cursor` |
| OpenCode | `opencode` |

---

## What's shipped

### Agent sessions
- Start and stop sessions for any supported provider, per project
- Full streaming chat timeline — tool calls, thinking blocks, diffs, error bubbles
- Turn summaries and loader states
- Rate-limit error bubble with reset time
- Answered `AskUserQuestion` cards rendered inline in the timeline

### Composer
- Slash commands: `/clear`, `/new`, `/model`, `/mode`, `/help`
- `@`-mention file picker — fuzzy search any project file, inserts as an inline chip
- Image and PDF attachments (drag-drop, paste, or button)
- Plan mode with `AskUserQuestion` card and `Shift+Tab` flow
- Mid-turn message queue

### Permission system
- Smart permission policy with always-allow and per-session overrides
- Redesigned permission prompt as a composer-slot card
- Permission inspector

### Sub-agents
- Cost-saving delegation — Opus 4.7 can spawn Haiku or Sonnet for sub-tasks
- Collapsible wrapper rows in the chat timeline
- Per-agent token accounting

### Git worktrees
- Per-chat git worktrees — each session gets an isolated working tree
- Per-repo settings
- Scoped `@`-mentions within a worktree

### PR & Changes pane
- PR tab with markdown rendering
- Changes tab with diff view
- Commit composer
- Checks tab with CI status glyphs

### File viewer & editor
- File tree with Material Icon Theme file-type icons
- Click-to-open any file in the main pane
- CodeMirror 6 editor — TS/TSX, JS, JSON, Markdown, HTML, CSS, Python, Rust, Go
- `Cmd+S` to save, mtime-based optimistic concurrency

### Layout & UI
- Three-pane layout: sidebar / chat / files+terminal
- Resizable panes
- Top bar with active session info
- PTY terminal (xterm.js + node-pty)

### Persistence & distribution
- SQLite stores projects, sessions, messages, tool calls across restarts
- Keychain-backed API keys (no plaintext storage)
- Signed + notarized macOS universal `.dmg` (Apple Silicon + Intel)
- In-app auto-update via GitHub Releases

---

## Tech stack

| | |
|---|---|
| Shell | Electron 33 |
| Renderer | React 19 + TypeScript + Vite |
| Styling | Tailwind CSS v4 + shadcn/ui (zinc dark) |
| State | Zustand (ephemeral) + SQLite (persistent) |
| IPC | @effect/rpc with Electron IPC transport |
| Runtime | Effect.ts (Layer, Stream, Schema) |
| Terminal | xterm.js + node-pty |
| Editor | CodeMirror 6 |
| Monorepo | Bun workspaces + Turbo |

---

## Monorepo layout

```
apps/
  desktop/     Electron shell
  renderer/    React UI (Vite)
  server/      All backend logic — Effect Layers
  web/         Next.js marketing site
packages/
  wire/        @zuse/wire — typed RPC contracts + branded IDs
  ui/          Shared React components
specs/
  0.01-MVP/    Foundation
  0.02-MVP/    File viewer & editor
  0.03-MVP/    Composer 2.0
  0.04-MVP/    Code index (spec complete, not yet built)
  sub-agents/  Sub-agent delegation
```

---

## Dev setup

```bash
# Install
bun install

# Dev (renderer + Electron)
turbo dev --filter=renderer --filter=desktop

# Build
turbo build

# Package macOS DMG (signed)
bun run dist:mac

# Package macOS DMG (unsigned, local testing)
bun run dist:mac:unsigned
```

Requires: Bun 1.3.10+, Node.js ≥ 18, macOS.

---

## Acknowledgements

Zuse Alpha is inspired by T3 code's work and built in our own opinionated way.
Special thanks to [Julius Marminge](https://github.com/juliusmarminge), a main
contributor to T3 code, whose work was a primary inspiration for our use of the
Effect library.
