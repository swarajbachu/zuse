# Feature: Composer 2.0

The chat composer in MVP 0.02 is a plain `<textarea>` with `Cmd+Enter`
submit. It has no slash commands, no file or image attachments, and no
useful behavior when a user types while a turn is in flight. MVP 0.03
turns the composer into a real editor: a CodeMirror 6 surface that
renders inline atomic chips for files and images, opens popovers on `/`
and `@`, accepts dropped images, sends on `Enter`, and queues anything
typed mid-turn as a steerable chip above the editor.

This document covers the editor itself, the popovers, and the
attachment pipeline. Skills (which appear in the slash popover) are
specified separately in [skills.md](skills.md). The mid-turn queue and
Steer affordance are in [queue-and-steer.md](queue-and-steer.md). The
choice of editor library is recorded in
[../decisions/0010-codemirror-composer.md](../decisions/0010-codemirror-composer.md).

## Behavior

### Editor surface

CodeMirror 6 mounted in a "prose" preset:

- No gutter, no line numbers, no fold markers.
- Soft-wrap on; horizontal scroll off.
- Auto-grow from a 56 px single-line height to a 240 px max, then
  scroll internally — same range the textarea uses today
  (`apps/renderer/src/components/chat-composer.tsx:38-39`).
- Placeholder rendered via `@codemirror/view`'s `placeholder` extension:
  `"Send a message…  Enter to send · Shift+Enter for newline"`.
- The editor host is split (`lib/codemirror/composer.ts` factory +
  `composer-chips.ts` + `composer-triggers.ts` + paste/drop handlers)
  for the same reason ADR 0009 gave: a future `Cmd+K`-on-selection
  inline command lands as one extension, not a rewrite.

### Inline chips

Files, directories, images, and skill invocations render as inline
**atomic widget decorations**. The chip DOM is:

```html
<span class="fz-chip" data-kind="file|directory|image|skill">
  <span class="fz-chip-icon"><!-- icon SVG --></span>
  <span class="fz-chip-divider"></span>
  <span class="fz-chip-label">specs</span>
</span>
```

Styling matches the screenshots the user supplied: rounded `border`,
muted-foreground icon, a thin vertical divider between icon and label,
tabular label. Chip variants:

| Variant       | Icon source                                                                 | Label                  |
| ------------- | --------------------------------------------------------------------------- | ---------------------- |
| `file`        | Material Icon Theme (basename → extension), via `lib/icons/material-icons.ts` (added in 0.02) | basename               |
| `directory`   | Material Icon Theme folder icon (open / closed by no state — chips are not expandable) | last path segment      |
| `image`       | a square thumbnail (32×32, object-fit cover) sourced from blob URL → `zuse://attachments/<id>` | original filename      |
| `skill`       | lucide `Sparkles`                                                           | skill name             |

Selection / editing semantics for any chip:

- The chip occupies one logical position in the document
  (`atomicRanges` decoration). Cursor cannot land inside it.
- Arrow keys step over the chip in one keypress.
- `Backspace` at the right edge of a chip, or `Delete` at its left
  edge, removes the entire chip.
- Click on a chip selects the range covering the chip; a follow-up
  Backspace/Delete removes it.
- Copy/cut serialize the chip back to its source token (`@<relPath>`,
  the original image filename in square brackets, or `/<skill-name>`)
  so paste-into-other-apps works.
- Drag the chip body to move it within the editor.

### Slash trigger (`/`)

The slash trigger is detected by a CodeMirror `ViewPlugin`
(`composer-triggers.ts`) that watches doc/selection changes:

- A `/` is a trigger only when preceded by start-of-input or whitespace.
- The trigger range is `/<query>` where `<query>` is the run of
  non-whitespace characters following the slash.
- While the trigger is active, the plugin emits an event that the React
  layer subscribes to and uses to position `SlashCommandPopover` above
  the editor.
- Typing keeps the popover open with the new query; whitespace, `Esc`,
  or moving the caret out of the trigger range closes it.

`SlashCommandPopover` is backed by `~/components/ui/command.tsx` (the
existing base-ui autocomplete). Sections in display order:

1. **Commands** — built-ins (resolve client-side; see "Built-in
   commands").
2. **Provider commands** — slash commands surfaced by the active
   provider beyond the built-ins (some providers expose their own).
3. **Skills** — project-scoped first, then global. Each row shows the
   skill name, a one-line description, and a subtle scope tag
   (`project` / `global`).

Confirming a popover row:

- Built-in commands replace the `/<query>` range with the canonical
  command token (still plain text — they execute on send, e.g.
  `/clear` clears editor + queue, `/model gpt-4` sets the model). The
  popover closes; the user can press `Enter` again to submit if they
  want, or keep typing.
- A skill confirmation replaces the `/<query>` range with a `skill`
  chip carrying `{ name, scope, args: "" }`. The user types arguments
  after the chip if the skill takes them.

Keyboard inside the popover:

- `↑`/`↓` move; `Enter` and `Tab` confirm; `Esc` closes; typing
  filters.
- While the popover is open, `Enter` does **not** submit the message.

### File trigger (`@`)

Mirror of the slash trigger:

- `@` is a trigger only when preceded by start-of-input or whitespace.
- Range: `@<query>`.
- `FileTagPopover` shows results from `workspace.searchFiles`
  (`packages/contracts/src/workspace.ts`).
- Confirming a result inserts a `file` or `directory` chip at the
  trigger range (the `@<query>` text is consumed).
- Same keyboard model as the slash popover.

### Image attachments

The composer accepts images from three sources:

- **Paste**. `EventHandler` extension intercepts `paste` events and
  filters `event.clipboardData.files` to entries with `mimeType`
  starting with `image/`.
- **Drop**. A wrapping React component owns `onDragOver` / `onDragEnter`
  / `onDragLeave` / `onDrop`, tracks nested-drag depth in a ref so the
  drop overlay doesn't flicker on hover transitions, and ignores drops
  that contain no image files.
- **Add-image button** in the composer footer (lucide `Paperclip`) for
  accessibility and non-DnD users; opens an `<input type="file" multiple
  accept="image/*">`.

For each accepted image:

1. Renderer computes a `blob` URL via `URL.createObjectURL(file)` for
   immediate preview.
2. An `image` chip is inserted at the cursor with `src=<blob URL>` and
   the original filename as the label.
3. Renderer reads the file as `Uint8Array` (`FileReader.readAsArrayBuffer`)
   and calls `attachments.upload({sessionId, bytes, mimeType,
   originalName})`.
4. On success, the chip's preview src swaps from the blob URL to
   `zuse://attachments/<id>`. The blob URL is revoked.
5. The chip carries an `AttachmentRef` in the `ComposerInput`'s
   `attachments` array when the message is submitted.

Limits, validated client-side and re-validated server-side:

- `MAX_IMAGE_BYTES = 100 * 1024 * 1024` (100 MB) per image.
- `MAX_ATTACHMENTS_PER_TURN = 20`.
- `mimeType` must start with `image/`.

If a drop exceeds either limit, the offending files are dropped with a
toast: `"Image too large (max 100 MB)"` or `"Maximum 20 attachments per
turn — N image(s) dropped"`.

### Attachment storage and cloud plan

0.03 stores image input locally first. The upload RPC is intentionally
named `attachments.upload` even though v1 writes to disk, because the
composer should not care whether the final backing store is local,
remote, or both.

Local storage is the source of truth in 0.03:

```
<userDataDir>/attachments/<sessionSegment>-<uuid>.<ext>
```

The renderer never reads this path directly. It stores only
`AttachmentRef.id` and renders images through
`zuse://attachments/<id>`. The desktop protocol handler resolves the
id to the local blob and returns the correct `content-type`.

The database reserves the future cloud shape on day one:

```sql
remote_url     TEXT,  -- final fetchable URL when cloud sync exists
remote_key     TEXT,  -- "attachments/<workspaceId>/<sessionId>/<id>.<ext>"
remote_status  TEXT   -- NULL | "pending" | "uploaded" | "failed"
```

Resolution order for rendering:

1. If `remote_url` is set and local blob is missing, use `remote_url`.
2. Otherwise use `zuse://attachments/<id>`.
3. If neither resolves, render the image chip in a missing-attachment
   state with filename and size.

The future sync worker uploads local blobs to
`attachments/<workspaceId>/<sessionId>/<id>.<ext>`, sets `remote_key`,
fills `remote_url`, and marks `remote_status = "uploaded"`. It is not
part of 0.03's implementation scope, but the schema and message format
make the migration additive.

### Built-in commands

Hardcoded in `apps/renderer/src/composer/builtin-commands.ts`. They
execute client-side at send time without a server roundtrip.

| Command          | Action                                                              |
| ---------------- | ------------------------------------------------------------------- |
| `/clear`         | Clear the editor and the per-session queue. No turn is sent.        |
| `/new`           | Create a new session in the current project (calls `session.create`). |
| `/model <id>`    | Switch the session's model (calls `session.setModel`).              |
| `/mode <name>`   | Switch the session's runtime mode (calls `session.setRuntimeMode`). |
| `/help`          | Open a popover listing all commands and skills with descriptions.   |

A built-in is detected at send time by checking the document's plain
text against the leading `/` token. Built-ins always supersede skills
with the same name.

### Keymap

| Keys                          | Action                                                       |
| ----------------------------- | ------------------------------------------------------------ |
| `Enter`                       | Submit (if non-empty and no popover is open).                |
| `Shift+Enter`                 | Newline.                                                     |
| `Cmd+Enter` / `Ctrl+Enter`    | Submit (backstop — kept for muscle memory from 0.02).        |
| `Esc`                         | Close the active popover; if none, blur the editor.          |
| `Tab` (inside popover)        | Confirm the highlighted popover row.                         |
| `Backspace` adjacent to chip  | Remove the chip.                                             |

### Submit pipeline

When the user submits:

1. Composer walks the document. Plain text spans become text segments;
   chips become typed segments (`AttachmentRef`, `FileRef`, `SkillRef`).
2. The result is assembled into a `ComposerInput`:

   ```ts
   {
     text: string,                  // raw text including `@…` and `/…` tokens
     attachments: AttachmentRef[],
     fileRefs: FileRef[],
     skillRefs: SkillRef[],
   }
   ```

3. If `runningBySession[sessionId] === true` (mirror of the
   `streamStatus` subscription in `apps/renderer/src/store/messages.ts:97`),
   the input is **queued** instead of sent. See
   [queue-and-steer.md](queue-and-steer.md) for queue behavior.
4. Otherwise, the input is sent via `messages.send` and the editor is
   cleared.

Built-in commands intercept the pipeline before step 3: a leading `/clear`
clears the editor and queue; `/new`, `/model`, `/mode` call the matching
RPC and clear the editor; `/help` opens the help popover.

## RPC contracts

Added to `packages/contracts/`:

```ts
// packages/contracts/src/composer.ts (new)
export const AttachmentRef = Schema.Struct({
  id: Schema.String,                      // "<sessionSegment>-<uuid>"
  mimeType: Schema.String,
  originalName: Schema.String,
});

export const FileRef = Schema.Struct({
  relPath: Schema.String,
  absPath: Schema.String,
});

export const SkillRef = Schema.Struct({
  name: Schema.String,
  scope: Schema.Literal("global", "project"),
  args: Schema.String,
});

export class ComposerInput extends Schema.Class<ComposerInput>("ComposerInput")({
  text: Schema.String,
  attachments: Schema.Array(AttachmentRef),
  fileRefs: Schema.Array(FileRef),
  skillRefs: Schema.Array(SkillRef),
}) {}

// packages/contracts/src/attachment.ts (new)
export const AttachmentUploadRpc = Rpc.make("attachments.upload", {
  payload: Schema.Struct({
    sessionId: SessionId,
    bytes: Schema.Uint8Array,
    mimeType: Schema.String,
    originalName: Schema.String,
  }),
  success: Schema.Struct({
    id: Schema.String,
    sizeBytes: Schema.Number,
    mimeType: Schema.String,
    ext: Schema.String,
  }),
  error: Schema.Union(
    AttachmentTooLargeError,
    AttachmentBadMimeError,
    SessionNotFoundError,
  ),
});

export const AttachmentTouchRpc = Rpc.make("attachments.touch", {
  payload: Schema.Struct({ ids: Schema.Array(Schema.String) }),
  success: Schema.Void,
});

// packages/contracts/src/workspace.ts (new)
export const WorkspaceSearchFilesRpc = Rpc.make("workspace.searchFiles", {
  payload: Schema.Struct({
    projectId: FolderId,
    query: Schema.String,
    limit: Schema.optional(Schema.Number),   // default 20
  }),
  success: Schema.Array(Schema.Struct({
    relPath: Schema.String,
    absPath: Schema.String,
    kind: Schema.Literal("file", "directory"),
  })),
  error: FsFolderNotFoundError,
});

// packages/contracts/src/session.ts (edit)
// MessagesSendRpc payload changes from { sessionId, text } to
// { sessionId, input: ComposerInput }. Old callsites in
// apps/renderer/src/store/messages.ts wrap the string in a
// ComposerInput shell with empty arrays.
//
// MessageContent gains a new tagged variant:
const UserRichContent = Schema.TaggedStruct("user_rich", {
  text: Schema.String,
  attachments: Schema.Array(AttachmentRef),
  fileRefs: Schema.Array(FileRef),
  skillRefs: Schema.Array(SkillRef),
});
// The existing UserContent ("user") stays — old rows render unchanged.
```

The new RPC groups (`attachment`, `workspace`, `composer`,
`skill` — see [skills.md](skills.md)) are registered in
`packages/contracts/src/rpc.ts`.

## Server-side attachment store

Disk layout under Electron's `app.getPath("userData")`:

```
<userDataDir>/attachments/<sessionSegment>-<uuid>.<ext>
```

- `<sessionSegment>` is the lowercase session id sanitized to
  `[a-z0-9-]`, capped at 80 chars.
- `<uuid>` is a v4 UUID.
- `<ext>` is derived from MIME via `apps/server/src/attachment/image-mime.ts`
  (`image/png` → `.png`, `image/jpeg` → `.jpg`, `image/webp` → `.webp`,
  `image/gif` → `.gif`; everything else → `.bin`).

SQLite tables added (no message-level migration — `messages.content_json`
is already a JSON column):

```sql
CREATE TABLE attachments (
  id            TEXT PRIMARY KEY,         -- "<sessionSegment>-<uuid>"
  session_id    TEXT NOT NULL,
  mime_type     TEXT NOT NULL,
  size_bytes    INTEGER NOT NULL,
  original_name TEXT NOT NULL,
  created_at    TEXT NOT NULL,
  remote_url    TEXT,                      -- nullable; future cloud fetch URL
  remote_key    TEXT,                      -- nullable; future cloud object key
  remote_status TEXT                       -- NULL | "pending" | "uploaded" | "failed"
);

CREATE TABLE message_attachments (
  message_id    TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  attachment_id TEXT NOT NULL REFERENCES attachments(id),
  PRIMARY KEY (message_id, attachment_id)
);
```

Garbage collection (`apps/server/src/attachment/attachment-store.ts`):

- Runs once at app start and once per 24 h while running.
- Deletes blob files + `attachments` rows where: no row in
  `message_attachments` references the id, **and** `created_at` is
  older than 24 h, **and** the renderer has not heartbeat the id in
  the last 90 s.
- Renderer heartbeat: `useAttachmentsStore` calls `attachments.touch`
  every 30 s with the ids currently in any composer draft or queue
  chip. The server keeps an in-memory `lastTouchedAt[id]` map.

### `zuse://attachments/<id>` protocol

`apps/desktop/src/main.ts` registers a custom protocol so `<img src>`
can resolve attachment ids without a JS roundtrip:

```ts
protocol.handle("memoize", (request) => {
  // parse <id> from request.url; map to <userDataDir>/attachments/<id>.<ext>
  // return new Response(stream, { headers: { "content-type": mime } })
});
```

The renderer prefers `zuse://` URLs in `<img>` tags both for live
chips (after upload) and for past-message rendering.

## Renderer state

```ts
// apps/renderer/src/store/attachments.ts (new)
type AttachmentDraft = { id: string; mimeType: string; originalName: string };
activeDraftIds: Set<string>;                 // touched on heartbeat every 30s
uploadOne(sessionId, file): Promise<AttachmentRef>;

// apps/renderer/src/store/messages.ts (edit)
send(sessionId, input: ComposerInput): Promise<void>;   // was (sessionId, text)
```

Composer-local state lives inside `ChatComposer` and the CodeMirror
view; it is not lifted into Zustand.

## Components added / changed

| File                                                                  | Status | Purpose                                                                  |
| --------------------------------------------------------------------- | ------ | ------------------------------------------------------------------------ |
| `apps/renderer/src/components/chat-composer.tsx`                      | edit   | Replace textarea with CodeMirror; mount popovers, queue tray, attachment chips. |
| `apps/renderer/src/lib/codemirror/composer.ts`                        | new    | EditorView factory for prose mode + composer extensions.                  |
| `apps/renderer/src/lib/codemirror/composer-chips.ts`                  | new    | `WidgetType` + `atomicRange` decoration + chip DOM renderer.              |
| `apps/renderer/src/lib/codemirror/composer-triggers.ts`               | new    | `/` and `@` detection extensions; emits trigger events.                   |
| `apps/renderer/src/lib/codemirror/composer-keymap.ts`                 | new    | Enter/Shift-Enter/Cmd-Enter keymap; popover-aware Enter swallow.          |
| `apps/renderer/src/components/composer/slash-command-popover.tsx`     | new    | Popover backed by `ui/command.tsx`; sections for Commands / Provider / Skills. |
| `apps/renderer/src/components/composer/file-tag-popover.tsx`          | new    | File picker popover; uses `workspace.searchFiles`.                        |
| `apps/renderer/src/components/composer/attachment-chip.tsx`           | new    | React renderer for chip DOM; reuses `lib/icons/material-icons.ts` from 0.02. |
| `apps/renderer/src/components/composer/queue-tray.tsx`                | new    | Chip strip above the editor for queued messages (see queue-and-steer.md). |
| `apps/renderer/src/composer/segment-parser.ts`                        | new    | Pure document-walk that builds `ComposerInput` from editor state.         |
| `apps/renderer/src/composer/builtin-commands.ts`                      | new    | The five built-in commands and their resolvers.                           |
| `apps/renderer/src/store/skills.ts`                                   | new    | Per-session skill list, fed by `skill.stream`. (see skills.md)             |
| `apps/renderer/src/store/attachments.ts`                              | new    | Upload + heartbeat.                                                       |
| `apps/renderer/src/store/messages.ts`                                 | edit   | `send` now takes `ComposerInput`; queue + steer state added in queue-and-steer.md. |
| `apps/desktop/src/main.ts`                                            | edit   | Register `zuse://attachments/<id>` protocol handler.                  |
| `apps/server/src/attachment/attachment-store.ts`                      | new    | Disk write under userData, GC sweep, heartbeat tracking.                  |
| `apps/server/src/attachment/image-mime.ts`                            | new    | MIME → extension map.                                                     |
| `apps/server/src/workspace/file-search.ts`                            | new    | `.gitignore`-aware walker for `workspace.searchFiles`.                    |
| `apps/server/src/provider/services/provider-service.ts`               | edit   | Accept `ComposerInput`; expand `fileRefs` (read file contents at send).   |
| `apps/server/src/provider/drivers/claude.ts`                          | edit   | Map `attachments` to image content blocks; honor `skillRefs`.             |
| `apps/server/src/provider/drivers/codex.ts`                           | edit   | Drop attachments with toast (Codex CLI image-input not supported); honor `skillRefs`. |
| `packages/contracts/src/composer.ts`                                       | new    | `ComposerInput`, `AttachmentRef`, `FileRef`, `SkillRef`.                  |
| `packages/contracts/src/attachment.ts`                                     | new    | Upload + Touch RPCs.                                                      |
| `packages/contracts/src/workspace.ts`                                      | new    | Search-files RPC.                                                         |
| `packages/contracts/src/session.ts`                                        | edit   | `UserRichContent` + updated `MessagesSendRpc` payload.                    |
| `packages/contracts/src/rpc.ts`                                            | edit   | Register new RPC groups.                                                  |

## Acceptance criteria

A1. Typing `/cl` shows `/clear` highlighted in the popover; pressing
    `Enter` confirms it (the popover closes and the editor still shows
    `/clear`); pressing `Enter` again clears the editor and any queue
    chips.

A2. With `~/.claude/skills/rate.md` present and a Claude session active,
    typing `/r` shows `rate` under Skills; pressing `Enter` inserts a
    `skill` chip (sparkles icon | "rate") into the editor.

A3. Switching the same session to Codex hides Claude skills and shows
    skills the Codex CLI reports from `~/.codex/skills/` (covered also
    in [skills.md](skills.md)).

A4. Typing `@chat-comp` shows file matches; pressing `Enter` inserts a
    `file` chip (TS-icon | `chat-composer.tsx`) at the cursor; the
    `@<query>` literal is consumed.

A5. With the cursor immediately after any chip, pressing `Backspace`
    removes the entire chip in one keypress; `Delete` from the position
    immediately before the chip does the same.

A6. Dropping a PNG inserts an `image` chip with a thumbnail; the chip's
    `<img src>` is a blob URL until `attachments.upload` resolves, then
    swaps to `zuse://attachments/<id>`. The blob URL is revoked.

A7. With a non-empty editor and no popover open, `Enter` submits;
    `Shift+Enter` inserts a newline; `Cmd+Enter` also submits.

A8. While `runningBySession[sessionId] === true`, pressing `Enter`
    creates a queue chip and clears the editor (see
    [queue-and-steer.md](queue-and-steer.md)).

A9. After restarting the app, opening a past session renders historic
    image attachments via `zuse://attachments/<id>` (no missing
    images).

A10. Dragging a 110 MB image onto the composer shows a toast `"Image too
     large (max 100 MB)"` and inserts no chip.

A11. Dropping 25 images at once accepts the first 20 and shows a toast
     `"Maximum 20 attachments per turn — 5 image(s) dropped"`.

A12. `bun run check-types` passes for `apps/renderer`, `apps/server`,
     and `packages/contracts`.

## Future hooks (intentional shape, not built yet)

- **`Cmd+K` on selection** carries forward from 0.02. The same CodeMirror
  extension that powers it for the file editor (ADR 0009) plugs into
  the composer because both surfaces share the same editor host.
- **Cloud sync** of attachments via `attachments.remote_url`. A sync
  worker uploads orphan-pending blobs to a cloud bucket, fills the
  column, and the renderer prefers the remote URL when set.
- **Boundary-aware steer** — defer the interrupt until the next
  tool-call boundary so the assistant's last completed thought is
  preserved. See [queue-and-steer.md](queue-and-steer.md).
- **Symbol-mention chips** — extend the `@` trigger so `@functionName`
  resolves to a `code` chip pointing at a definition. The chip
  primitive supports it; only the search backend needs work.
