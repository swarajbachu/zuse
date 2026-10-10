# Chat annotations

Selecting text anywhere in a chat transcript opens a floating menu with
Annotate and Copy. Selection works in assistant replies, the user's own
messages, and generated UI blocks.

- **Annotate** opens the same draft card as file annotations
  (`DraftReviewAnnotation`) and pins the note to the selected text. It joins the composer's
  annotation tray, next to code and browser annotations. It is sent with the
  next message and stays visible on that message's annotations pill.
- **Copy** copies the selected text.

## Data

`ChatAnnotation` (`_tag: "chat"`) in `packages/contracts/src/composer.ts`
stores the message ID where the selection started, its source (`assistant`,
`user`, or `ui`), the quoted text, and the note. Quotes longer than 2,000
characters are truncated. `serializeAnnotations` in
`packages/client-runtime/src/composer-feedback.ts` sends them to the agent
before other annotations:

```text
Notes on the conversation:
1. On the UI you rendered: "Migration 0042 locks the users table." — Can we run this off-peak?
```

## Renderer

- `MessageRow` tags assistant, user, and `ui_spec` rows with
  `data-chat-message` and `data-chat-source`. Other rows (tools, thinking,
  errors) are not annotatable.
- `readChatSelection` in `apps/renderer/src/lib/chat-selection.ts` maps the DOM
  selection to a message. A selection that spans messages belongs to the
  message it starts in.
- `ChatSelectionMenu` is mounted once per chat view. It listens for pointer and
  key releases and hides when the selection collapses, the row scrolls out of
  the virtualized list, or Escape is pressed. While a note is being written,
  the CSS Custom Highlight API keeps the selected text highlighted.
- Notes are added to the chat's own session, not to the focused session.
