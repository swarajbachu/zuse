# MVP 0.02 — File viewer & minimal editor

MVP 0.01 (everything under [../0.01-MVP/](../0.01-MVP/)) shipped a chat-first
desktop app with a read-only project file tree on the right. MVP 0.02 turns
that read-only tree into a working file surface: type-aware icons,
click-to-open, and a minimal editor that can save changes back to disk.

## What lands in 0.02

- **File-type icons** in the right-pane file tree using
  [Material Icon Theme](https://github.com/material-extensions/vscode-material-icon-theme).
  `.tsx` shows the TypeScript icon, `.gitignore` the git icon, etc.
- **Click-to-open**: clicking a file row opens it in the main pane.
- **Two-tab main pane**: a permanent **Chat** tab and at most **one** file
  tab. Opening a different file replaces (never stacks) the file tab.
- **Minimal editor** based on CodeMirror 6 with language packs for the
  formats memoize users edit most (TS/TSX/JS/JSON/Markdown/HTML/CSS/Python/
  Rust/Go), dirty-dot indicator, `Cmd/Ctrl+S` to save.
- **Conflict-aware writes** via mtime-based optimistic concurrency: the
  server rejects writes if the file changed on disk since we read it.
- **Image preview and binary guard**: supported raster images render inline;
  other non-UTF-8 files and files over 5 MB render a placeholder.

## What's deliberately deferred

- Multi-file tabs and pinning.
- Settings page autosave-debounce toggle (the store leaves a `autosave`
  flag in place; UI surface comes later).
- `Cmd+K` on selection → inline AI command bar (the editor host is split
  so this slots in cleanly).
- Format-on-save / Prettier integration.
- Diff / merge UI on save conflict — 0.02 only shows a toast.
- File create / rename / delete from the tree right-click menu.

## Where to read

- [features/file-viewer.md](features/file-viewer.md) — feature deep dive
  (RPCs, layout, editor scope, save semantics, future hooks)
- [decisions/0009-codemirror-over-monaco.md](decisions/0009-codemirror-over-monaco.md) —
  why CodeMirror 6 fits the "minimal but extensible" target

## Status

📐 **Spec** — scoped, in progress.
