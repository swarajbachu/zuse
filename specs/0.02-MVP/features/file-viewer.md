# Feature: File viewer & editor

The right-pane file tree is the only window onto the user's project
filesystem inside memoize. In MVP 0.01 it was a read-only browse surface
with generic file/folder icons. MVP 0.02 turns it into a working editor:
type-aware icons, click-to-open in the main pane, and a save-capable
minimal editor.

## Behavior

### Right pane — file tree

- Each file row renders an icon resolved through the Material Icon Theme
  manifest (matched on basename → extension → default).
- Each folder row renders the matching folder icon (open vs closed
  variants when expanded / collapsed).
- Clicking a **file** row opens that file in the main pane's file tab.
- Clicking a **folder** row toggles expansion (unchanged from 0.01).
- The currently open file's row gets a subtle highlight so users can
  see which entry is mounted in the editor.

### Main pane — two tabs

```
┌────────────────────────────────────────────────────┐
│  [● Chat]  [README.md •]                [×]        │  ← tab strip
├────────────────────────────────────────────────────┤
│                                                    │
│   editor (or chat) for the active tab              │
│                                                    │
└────────────────────────────────────────────────────┘
```

- **Chat** tab is always present and cannot be closed. Selecting it
  shows the full chat surface (timeline + composer) for the active
  session — same content the user sees today, just behind a tab.
- The **file** tab appears only when a file is open. Its label is the
  file basename plus a dirty-dot (`•`) when content diverges from disk.
  The `×` closes the file tab and snaps focus back to Chat.
- Opening a different file replaces the existing file tab. There is
  no scenario in 0.02 where two file tabs exist at once.
- Both tab contents stay mounted via a `hidden` toggle (mirroring
  `RightPane`'s files/terminal pattern), so chat scroll position and
  editor undo stack are preserved when switching tabs.
- Switching projects in the left sidebar closes the file tab.

### Editor

- **CodeMirror 6** with `basicSetup`, dark theme matched to the existing
  zinc-950 chrome.
- Language detected by file extension:
  - TS/TSX/JS/JSX → `@codemirror/lang-javascript` (with `jsx`/`typescript`
    flags)
  - JSON → `@codemirror/lang-json`
  - Markdown → `@codemirror/lang-markdown`
  - HTML / CSS / Python / Rust / Go → respective `@codemirror/lang-*`
  - Anything else → no language extension (plain monospace).
- Editor host is split into:
  - `lib/codemirror/setup.ts` — the EditorView factory.
  - `lib/codemirror/languages.ts` — extension → language picker.
  - `components/file-editor.tsx` — React lifecycle, dirty tracking, save
    keymap, conflict handling.
  This separation gives a future `Cmd+K`-on-selection inline assist a
  clean place to land without rewriting the editor host.

### Saving

- `Cmd+S` (or `Ctrl+S` on non-Mac) triggers `fs.writeFile` with the
  current content and the `mtime` from the last read.
- Successful save: editor stores the new mtime and clears the dirty dot.
- `FsConflictError` (mtime drift): non-blocking toast — "File changed on
  disk — discard your changes and reload?". Editor content is preserved;
  user can either click reload (re-reads from disk, drops their edits)
  or keep editing (next save attempt re-issues with the original mtime
  and will keep failing until they reload — by design).
- `FsTooLargeError`, `FsReadError`, `FsPathOutsideError`: surfaced as a
  one-line toast; the file tab still mounts so the user can close it.
- No auto-save in 0.02. The store carries an `autosave: boolean` flag
  hard-coded to `false` so a future settings toggle is a one-liner.

### Binary / oversize files

- Server caps reads at 5 MB; over the cap returns `FsTooLargeError`.
- Server attempts UTF-8 decode; if it fails, returns
  `{ kind: "binary", bytes, size }`.
- Supported raster images render inline. Other binary files retain the
  "Binary file (N bytes)" placeholder; `Cmd+S` is no-oped in binary mode.

## RPC contracts

Added to `packages/contracts/src/fs.ts`:

```ts
// fs.readFile
payload: { folderId, path }
success: { kind: "text", content, mtime, size }
       | { kind: "binary", bytes, size }
error:   FsFolderNotFoundError | FsPathOutsideError
       | FsReadError | FsTooLargeError

// fs.writeFile
payload: { folderId, path, content, expectedMtime }
success: { mtime }
error:   FsFolderNotFoundError | FsPathOutsideError
       | FsReadError | FsConflictError | FsTooLargeError
```

Both reuse the existing `resolveInsideFolder` path-canonicalization
helper used by `fs.tree`. Path validation happens in one place; new
handlers do not duplicate it.

## Renderer state

`useUiStore` (in `apps/renderer/src/store/ui.ts`) gains:

```ts
type MainTab = "chat" | "file";
type OpenFile = { folderId: FolderId; path: string; name: string };

activeMainTab: MainTab;
openFile: OpenFile | null;
autosave: boolean;          // 0.02 hard-codes false
setActiveMainTab(tab): void;
openFileInTab(file): void;  // sets openFile + activeMainTab="file"
closeFileTab(): void;       // clears openFile + activeMainTab="chat"
```

Switching projects in `useWorkspaceStore` clears `openFile`.

## Components added / changed

| File | Status | Purpose |
|------|--------|---------|
| `apps/renderer/src/components/main-tabs.tsx`            | new    | top-of-main-pane tab strip |
| `apps/renderer/src/components/file-editor.tsx`          | new    | CodeMirror host, dirty + save |
| `apps/renderer/src/components/file-icon.tsx`            | new    | Material Icon Theme resolver |
| `apps/renderer/src/lib/icons/material-icons.ts`         | new    | manifest → icon-name lookup |
| `apps/renderer/src/lib/codemirror/setup.ts`             | new    | EditorView factory |
| `apps/renderer/src/lib/codemirror/languages.ts`         | new    | extension → language extension |
| `apps/renderer/src/components/file-tree.tsx`            | edit   | clickable rows + FileIcon |
| `apps/renderer/src/store/ui.ts`                         | edit   | tabs + openFile state |
| `apps/renderer/src/app.tsx`                             | edit   | render MainTabs + conditional ChatView/FileEditor |
| `packages/contracts/src/fs.ts`                               | edit   | new RPCs + errors |
| `packages/contracts/src/rpc.ts`                              | edit   | register new RPCs |
| `apps/server/src/fs/services/*` and `handlers.ts`       | edit   | implement read/write handlers |

## Future hooks (intentional shape, not built yet)

- **`Cmd+K` inline AI assist on selection.** The editor host's split
  (`setup.ts` + `languages.ts` + `file-editor.tsx`) is structured so a
  selection-aware command palette can be added as another CodeMirror
  extension without touching the React component tree.
- **Settings autosave toggle.** Already wired through `useUiStore`'s
  `autosave` flag; surfacing it is a settings-page change, not an
  editor change.
- **Format-on-save** and **diff-on-conflict** remain explicit non-goals
  for 0.02.

## Acceptance criteria

A1. File tree shows distinct icons for `.ts`, `.tsx`, `.md`, `.json`,
    `.gitignore`, `.css`, `.py`, `package.json`, plus folder icons.

A2. Clicking a file in the tree opens the editor in the main pane with
    a `Chat | <basename>` tab strip; syntax highlighting matches the
    file's language.

A3. Opening a second file replaces the file tab — never two file tabs.

A4. Switching back to Chat preserves chat scroll position; switching
    back to the file tab preserves editor cursor + undo history.

A5. Edit and `Cmd+S` writes to disk; dirty-dot clears; `git diff`
    confirms the change.

A6. External edit + in-app `Cmd+S` produces a conflict toast and
    preserves the user's in-editor changes.

A7. Opening a supported raster image shows it inline without exposing its
    local path to the renderer.

A8. Switching projects in the left sidebar closes the file tab and
    selects the chat tab.

A9. `bun run check-types` passes for `apps/renderer`, `apps/server`,
    and `packages/contracts`.
