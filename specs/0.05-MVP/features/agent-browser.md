# Feature: In-App Agent Browser

Let the agent drive memoize's existing on-screen browser — navigate, read the
page, click, type, screenshot, and autofill dummy test logins — instead of
spinning up a separate headless Chrome. Because it's the same `<webview>` the
user is looking at, every action is visible: a camera **shutter flash** fires
when the agent takes a screenshot.

## Why this exists

Agent-browser products (e.g. Vercel's) launch a hidden headless Chrome the user
never sees. memoize already ships a real browser — the "Browser" tab in the
right pane (`apps/renderer/src/components/browser-pane.tsx`). Reusing it means:

- **No second browser process** — one Chromium, already on screen.
- **Visible by default** — the user watches the agent work; screenshots flash a
  shutter so "the agent just looked at the page" is legible.
- **"Go and verify" flows** — the agent can navigate to a dev server, log in
  with seeded test credentials, and confirm a change end-to-end.

## Architecture (the one hard fact)

> MCP tools run in the **server** process; the `<webview>` lives in the
> **renderer**.

So every browser tool round-trips **server → renderer → server**, cloned from
`PermissionService`: the server broadcasts a `BrowserCommandRequest` on
`browser.commands`, the renderer drives the webview, and replies on
`browser.respond`, resolving a server-side `Deferred` (30s timeout backstop so a
hidden/closed webview can't hang the agent turn).

```
Claude agent (server)
  → MCP tool (apps/server/src/provider/drivers/browser-tools.ts)
    → BrowserBridgeService.send(cmd)            [publish + await Deferred]
      → browser.commands stream → renderer
        → BrowserPane drives <webview>          [capturePage / executeJavaScript]
        ← browser.respond → resolves Deferred
    ← tool result (text or image block) → agent
```

Claude-only for v1 — the tools live in Claude's in-process MCP server
(`createSdkMcpServer`). The bridge is provider-agnostic, so ACP providers
(Grok/Gemini/Cursor) can be wired later without touching it.

## Tools (all `mcp__zuse__browser_*`)

| Tool | Does | Permission |
|---|---|---|
| `browser_navigate` | Load a URL, wait for it to settle | auto-allow |
| `browser_screenshot` | Capture the viewport → image block + shutter flash | auto-allow |
| `browser_snapshot` | Compact list of visible interactive elements, each with a stable `ref` | auto-allow |
| `browser_read` | Read visible page text (or one `ref`), truncated | auto-allow |
| `browser_scroll` | Scroll viewport (up/down/top/bottom) or a `ref` into view | auto-allow |
| `browser_hover` | Hover a `ref` to reveal menus/tooltips | auto-allow |
| `browser_console` | Recent console messages + page errors since last load | auto-allow |
| `browser_history` | back / forward / reload | auto-allow |
| `browser_wait` | Settle by `ms` or until a CSS `selector` appears | auto-allow |
| `browser_click` | Click an element by `ref` | **prompts** |
| `browser_type` | Type into an element by `ref`, optional submit | **prompts** |
| `browser_select` | Choose a `<select>` option by `ref` | **prompts** |
| `browser_press` | Press a key (Enter/Tab/Escape/Arrow…) on a `ref` or focus | **prompts** |
| `browser_login` | Autofill + submit the saved dummy login for an origin | **always prompts** (even full-access) |

Rule of thumb for permissions: read-only / navigational tools auto-allow; anything
that mutates page state (`click`, `type`, `select`, `press`) prompts; `login`
always prompts even in full-access mode.

**Console capture** comes from the webview's `console-message` + `did-fail-load`
events, buffered per page load (cleared on navigation). It catches `console.*`
and load failures; uncaught-exception capture beyond that would need an injected
error hook (follow-up).

**Targeting** uses a DOM/accessibility snapshot (Playwright-style): `browser_snapshot`
mints stable `data-mz-ref` ids on visible interactive elements; `click`/`type`
act by `ref`, never by coordinates — robust to scroll, DPI, and responsive
layout. Refs are regenerated per snapshot.

## Credentials — dummy/test logins ONLY

The credential feature exists for **seeded test logins** on dev/staging sites the
agent verifies. The settings UI (Settings → Browser) shows a load-bearing
warning: **never store a real or production password.**

Defense in depth even so:
- Passwords live in the **OS keychain** (`browserCred:<origin>`, reusing the
  keytar pattern in `credentials-service.ts`).
- The `Login` command carries **only the origin**. The renderer pulls the secret
  out-of-band via `browser.fillForOrigin` (renderer-only RPC) and injects it
  straight into the page's fields.
- The password **never enters the LLM context** — not in tool args, tool
  results, the agent event stream, or the command broadcast. `browser_login`'s
  result is only `{ ok, detail }` with the password omitted.

## Non-goals (v1)

- Multi-provider (Claude only).
- Full-page (scrolling) screenshots — viewport only.
- Cross-origin iframe interaction (executeJavaScript can't reach them).
- Persisting browser history across renderer reloads.
- Concurrent sessions sharing the webview — last-command-wins; gate on the
  active session if it becomes a problem.

## Key files

- Wire: `packages/wire/src/browser.ts` (commands, results, RPCs), registered in `rpc.ts`.
- Server bridge: `apps/server/src/provider/{services,layers}/browser-bridge-service.ts`.
- Tools: `apps/server/src/provider/drivers/browser-tools.ts`; registered + policy in `drivers/claude.ts`.
- RPC handlers: `apps/server/src/provider/handlers.ts`; layer wiring in `runtime.ts`.
- Credentials: `apps/server/src/provider/{services,layers}/credentials-service.ts` (`browserCred:` namespace).
- Renderer executor + shutter: `apps/renderer/src/components/browser-pane.tsx`, `browser-shutter.tsx`.
- Settings UI: `apps/renderer/src/components/settings-page.tsx` (Browser pane).
- Timeline icons/labels: `apps/renderer/src/components/tool-row.tsx`.

## Risks / verification notes

- **capturePage on a hidden tab** can return empty — mitigated by force-showing
  the Browser tab on every command + a paint delay before capture. Verify
  empirically.
- **Shutter z-order** — the overlay sits above the webview at `z-10`; in current
  Electron `<webview>` composites in-page so this works, but confirm visually.
- **MCP image tool results** — `browser_screenshot` returns an MCP `image`
  content block; confirm Claude receives it as a visible image.

## How to verify end-to-end

1. **Navigate + screenshot**: ask Claude `"open https://example.com and take a
   screenshot"`. Expect the right pane to switch to Browser, the page to load,
   a shutter flash, and the agent's reply to reference the screenshot.
2. **Interact**: point it at a local form; `"fill the email field with
   test@test.com and submit"`; confirm with a follow-up `browser_snapshot`.
3. **Auto-login**: add a dummy credential for a local dev app's origin in
   Settings → Browser; prompt `"log in and verify the dashboard loads"`. Confirm
   the approval prompt appears, the flow completes, and the password appears
   nowhere in the session transcript.
