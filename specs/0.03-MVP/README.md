# MVP 0.03 — Composer 2.0

MVP 0.02 (everything under [../0.02-MVP/](../0.02-MVP/)) brought the file
viewer/editor to the main pane. MVP 0.03 brings the same level of polish to
the chat composer: the textarea becomes a real editor with inline atomic
chips for files and images, slash commands and skills are surfaced inline,
images are attached by paste/drop, and messages typed mid-turn become
first-class queued items the user can steer into the running conversation.

## What lands in 0.03

- **Slash commands**. Typing `/` opens a popover with built-in commands
  (`/clear`, `/new`, `/model`, `/mode`, `/help`) plus the active provider's
  skills.
- **Skills**, scoped to the active session's provider. Claude sessions show
  skills the Claude SDK reports from `~/.claude/skills/` and project-level
  `.claude/skills/`; Codex sessions show skills the Codex CLI reports from
  `~/.codex/skills/` and project-level `.codex/skills/`. Memoize owns no
  skill directory of its own.
- **File tagging via `@`**. Typing `@` opens a workspace-aware file picker;
  picking a file inserts an inline atomic chip (icon | label) at the cursor.
- **Image attachments** by drag-drop, paste, or paperclip button. Images
  render as inline atomic chips with a thumbnail; binaries are persisted
  under the app's userData directory and served back to the renderer via a
  custom `zuse://attachments/<id>` protocol. The data model reserves
  cloud fields so sync can land later without changing message history.
- **`Enter` to send**, `Shift+Enter` for newline. `Cmd+Enter` continues to
  work as a backstop.
- **Mid-turn message queue with Steer**. Pressing `Enter` while a turn is
  in flight puts the message into a queue rendered as a chip strip above
  the editor. Each queue chip carries an arrow icon (hover tooltip
  `"Steer"`) that interrupts the running turn and sends the queued text as
  the next user turn. Anything still queued when the turn ends naturally
  auto-flushes in order.

## What's deliberately deferred

- Cloud sync execution. 0.03 defines the local path, database columns,
  cloud object-key shape, and resolution order; the uploader worker itself
  is deferred.
- In-app skill authoring UI. Users edit skill markdown in their editor of
  choice, in the destination directory of their choice.
- Image *output* / agent-generated images. 0.03 covers user image *input*.
- Boundary-aware steer (interrupting only at safe tool-call boundaries
  rather than mid-token). Useful polish; not in scope for v1.
- Multi-cursor or rich-text formatting in the composer. The editor is for
  prose with chips, not for code.
- Inline-rendered code chips for symbol mentions. The chip primitive
  supports it; the search backend does not.

## Where to read

- [features/composer.md](features/composer.md) — editor surface, inline
  chips, slash & file popovers, image attachments, keymap, RPCs.
- [features/skills.md](features/skills.md) — provider-delegated skill
  discovery and resolution at send time.
- [features/queue-and-steer.md](features/queue-and-steer.md) — mid-turn
  queue, Steer arrow, RPC contract, auto-flush behavior.
- [decisions/0010-codemirror-composer.md](decisions/0010-codemirror-composer.md) —
  CodeMirror 6 with a prose preset + atomic widget decorations for the
  composer.
- [decisions/0011-skills-via-provider.md](decisions/0011-skills-via-provider.md) —
  why skill discovery is delegated to the provider driver instead of a
  memoize-owned directory.
- [decisions/0012-steer-via-interrupt.md](decisions/0012-steer-via-interrupt.md) —
  why "Steer" is interrupt + send rather than mid-stream injection.

## Status

📐 **Spec** — ready for implementation.
