# Feature: Terminal

Ghostty VT renders terminal state on desktop, iOS, and Android; `node-pty`
backs desktop and remote shells. The established right-pane terminal remains a
multi-instance panel. A second, independently owned multi-instance collection
lives in the collapsible bottom dock. Both collections are scoped to the chat,
and switching panels, hiding the bottom dock, or changing chats preserves the
running process and scrollback.

## Lifecycle

1. The client hydrates the owner-qualified terminal catalog before allocating a
   shell.
2. The client requests `pty.open` with dimensions, cwd, ownership, and a stable
   open token. Replayed opens reconcile to the same process.
3. The server spawns `node-pty` with the user's login shell and returns a PTY id
   plus process epoch. The client resumes output from its last acknowledged
   cursor and resets Ghostty when a replay gap or new epoch requires it.
4. Surface unmount only detaches rendering. Explicit tab close, chat disposal,
   or owner cleanup closes the backing process.
5. Exited or disconnected terminals remain recoverable through explicit
   restart; restart keeps the logical terminal identity and advances its
   process epoch.

## Resize

The renderer fits Ghostty to the visible host and sends a debounced `pty.resize`
after layout settles. Hidden surfaces refit when reattached.

## Encoding

UTF-8 throughout. Output chunks are passed verbatim to Ghostty VT, including
terminal query replies, keyboard modes, bracketed paste, mouse reporting, and
OSC 8 hyperlinks.

## Scrollback

Ghostty owns bounded in-memory scrollback for each retained terminal. The
server retains a bounded output journal for reconnect and reports a replay gap
when the requested cursor is older than the retained journal.

## Activity signaling (Phase 2+)

Runtime status is projected from the shared terminal resource. Connecting,
reconnecting, exited, and failed states remain visible and do not manufacture a
second process.
