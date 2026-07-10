# Feature: Agent Browser v2 — DevTools eyes, test-runner hands

v1 gave the agent a visible browser it can drive: 14 `mcp__zuse__browser_*`
tools over the app's on-screen `<webview>`, real CDP input, a rendered cursor,
and a shutter flash on screenshots. v2 upgrades **what the agent can perceive**
— a real accessibility-tree snapshot, network activity, uncaught exceptions,
full-page captures — and **how cheaply it can act**: batch form fill, richer
waits, dialog handling. The webview stays visible; the user keeps watching.

## Why v2

Two things changed since the v1 spec:

1. **The industry converged on a targeting model.** Playwright MCP, Chrome
   DevTools MCP, and Vercel's agent-browser all snapshot the browser's
   _accessibility tree_ and hand the model per-element refs (`e5`, `uid=…`,
   `@e1`). A structured snapshot costs roughly 500–5,000 tokens where a
   screenshot costs 10,000–50,000 — a 10–100× reduction — and it works for
   models without vision, survives scroll/DPI changes, and describes the whole
   document, not just the viewport. Screenshots are demoted to "when layout
   actually matters."
2. **Observability became table stakes.** Chrome DevTools MCP ships network
   request listing, console messages, and script evaluation as core tools;
   Cursor's embedded browser wires Chrome-level diagnostics into the agent.
   An agent that can't see the failed `POST /api/login` or the uncaught
   `TypeError` is debugging blind.

v1's snapshot walks the DOM from injected page JS: it tags interactive
elements with `data-mz-ref` attributes, sees only ~the viewport (+400px), and
can't describe page structure. v2 replaces it at the root.

### What competitors do (and what we keep doing differently)

|                         | Targeting                | Observability                       | User sees it?                              | Where it runs                    |
| ----------------------- | ------------------------ | ----------------------------------- | ------------------------------------------ | -------------------------------- |
| Playwright MCP          | a11y snapshot + refs     | console, network, tracing (opt-in)  | headed or headless, separate window        | spawned browser                  |
| Chrome DevTools MCP     | a11y snapshot + uids     | network, console, perf traces, heap | user's Chrome or spawned                   | CDP to real Chrome               |
| Cursor embedded browser | CDP + element picker     | DevTools in-editor                  | yes, editor tab                            | Chromium in IDE                  |
| Claude in Chrome        | screenshots + DOM        | page-level                          | yes, side panel                            | extension in user's Chrome       |
| Vercel agent-browser    | a11y snapshot + refs     | console, network                    | headless daemon                            | background process               |
| **Zuse v2**             | **a11y snapshot + refs** | **console, errors, network**        | **always — same webview the user browses** | **in-app, zero extra processes** |

Public references:
[Playwright MCP snapshots](https://playwright.dev/docs/mcp#snapshots),
[Playwright MCP tools](https://playwright.dev/docs/mcp#tools),
[Chrome DevTools MCP](https://github.com/ChromeDevTools/chrome-devtools-mcp),
and
[Electron web embeds](https://www.electronjs.org/docs/latest/tutorial/web-embeds).

Our differentiator survives v2 unchanged: the agent drives **the browser tab
the user is already looking at**. Every action is watchable (cursor glide,
shutter flash), every mutation maps to a legible permission prompt, and there
is no second Chromium. **No headless mode in v2** — if concurrent sessions
ever contend for the browser, the answer is agent-owned _visible_ tabs
(P4), not a hidden browser the user can't audit.

## Architecture (unchanged hard fact)

> MCP tools run in the **server** process; the `<webview>` lives in the
> **renderer**. Every tool round-trips server → renderer → server via
> `BrowserBridgeService` (PubSub + Deferred, 30s deadline).

What v2 adds rides the plumbing v1 already built:

- Main already attaches `webContents.debugger` (CDP 1.3) to the webview for
  real input (`apps/desktop/src/main.ts`, `browser:registerWebview` /
  `browser:dispatchInput`). v2 opens that same attachment to more domains —
  **Accessibility** (tree snapshots), **DOM** (ref → coordinates), **Runtime**
  (exceptions, per-element function calls), **Network** (request log),
  **Page** (full-page capture, dialogs) — behind a method-allowlisted
  `browser:cdpCommand` IPC seam plus purpose-built buffer readers.
- The renderer keeps a per-snapshot `ref → backendNodeId` map. Actions resolve
  a ref through `DOM.scrollIntoViewIfNeeded` + `DOM.getContentQuads` to fresh
  viewport coordinates, then dispatch the same real CDP input as v1 (cursor
  glide and click pulse preserved). Element-value work (type/select/read)
  goes through `DOM.resolveNode` + `Runtime.callFunctionOn`, carrying over
  v1's React-safe value-setter verbatim.
- **Every CDP path falls back to the v1 behavior** (injected-JS snapshot,
  `data-mz-ref` targeting, synthetic events) when the debugger isn't attached
  — same graceful degradation contract as v1's click fallback.

## Tools (v2 surface — all `mcp__zuse__browser_*`)

Unchanged from v1: `navigate`, `read`, `scroll`, `hover`, `history`,
`click`, `type`, `select`, `press`, `login`. Upgraded or new:

| Tool                 | Does                                                                                                                                                                     | Permission  |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------- |
| `browser_snapshot`   | **Upgraded:** full-page accessibility tree (roles, names, states, values), interactive elements carry `ref=eN`. Structural nodes give context; refs are what you act on. | auto-allow  |
| `browser_wait`       | **Upgraded:** settle by `ms`, CSS `selector`, or **`text`** appearing on the page, with a configurable `timeoutMs` (≤25s, under the bridge's 30s deadline).              | auto-allow  |
| `browser_screenshot` | **Upgraded:** optional `fullPage: true` captures beyond the viewport via `Page.captureScreenshot`. Shutter flash still fires.                                            | auto-allow  |
| `browser_console`    | **Upgraded:** now includes uncaught exceptions (`Runtime.exceptionThrown`) captured in main, not just `console.*` events.                                                | auto-allow  |
| `browser_network`    | **New:** list requests since last load (method, URL, status, type), or drill into one by `id` (headers + truncated body).                                                | auto-allow  |
| `browser_fill_form`  | **New:** fill many fields (inputs and selects) in one call — one permission prompt, one round-trip, then optional submit.                                                | **prompts** |
| `browser_dialog`     | **New:** accept/dismiss the pending JS dialog (`alert`/`confirm`/`prompt`, optional `promptText`).                                                                       | **prompts** |

Mutation tools (`click`, `type`, `select`, `press`, `fill_form`) gain an
optional `element` argument — a human-readable description of the target
("the Sign in button") echoed into results and permission surfaces, following
Playwright MCP's ref + description convention.

Permission rule of thumb is unchanged: reads and user-visible navigation
auto-allow; page mutations prompt; `login` always prompts, even in
full-access mode. New classifications: `network` joins the read-only set;
`fill_form` and `dialog` fall through to the standard prompt.

## The verification loop (why all of this exists)

The canonical post-edit check the agent should run without hand-holding:

1. `browser_navigate` to the dev server (or `browser_history` reload).
2. `browser_wait` for the text/selector that proves the page rendered.
3. `browser_snapshot` — assert the expected structure/labels/values exist.
4. `browser_console` + `browser_network` — assert no new exceptions, no
   failed requests.
5. Only if layout itself is in question: `browser_screenshot`.

Steps 2–4 are pure text, auto-allowed, and cost a few thousand tokens total —
cheap enough to run after every meaningful change. Tool descriptions steer
the model toward this loop (snapshot-before-act, console/network-after-act).

## Non-goals (v2)

- **Headless / hidden browsing** — the visible webview is the product.
- **Real credentials** — dummy/test logins only; the v1 keychain design and
  always-prompt stance carry over untouched.
- **Performance tracing, heap analysis, Lighthouse** — Chrome DevTools MCP
  territory; revisit on demand.
- **Cross-origin iframe (OOPIF) targeting** — `Accessibility.getFullAXTree`
  covers same-process frames; OOPIFs need `Target.autoAttach` plumbing.
  Deferred.
- **Multi-provider** — tools remain on Claude's in-process MCP server; the
  bridge stays provider-agnostic for later ACP wiring.

## Implementation phases

| Phase  | What                                                                                                                                                                                                                                                                                                                                | Effort                     |
| ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------- |
| **P0** | A11y-tree snapshot over CDP + ref targeting via backendNodeId; `browser_wait` text/timeout. Spike inside: confirm `Accessibility.getFullAXTree` behavior over Electron's `webContents.debugger` (it's not part of the frozen 1.3 protocol on paper, but the live Chromium speaks it — fall back to the v1 DOM snapshot on failure). | M                          |
| **P1** | `browser_network` + uncaught-exception capture (Network/Runtime domains enabled at attach, ring buffers in main, cleared per load).                                                                                                                                                                                                 | M                          |
| **P2** | `browser_fill_form`, `fullPage` screenshots, `browser_dialog`, `element` descriptions on mutation tools; auto-allow unload (`will-prevent-unload`) so navigations can't wedge.                                                                                                                                                      | S–M                        |
| **P3** | Multi-tab (`browser_tabs`: agent-owned visible tabs in the pane) + localhost auto-attach: when the session's dev-server port is known, bare paths resolve against it (seam exists in `resolveUrl`, `browser-pane.tsx`).                                                                                                             | M                          |
| **P4** | `browser_verify_*` assertion tools (Playwright `--caps=testing` precedent), WebContentsView migration, ACP providers.                                                                                                                                                                                                               | L, triggered not scheduled |

P0–P2 ship together in this branch. P3+ are specced here, built later.

## Key files

Everything from the v1 spec's list, plus:

- CDP seam: `apps/desktop/src/main.ts` (`browser:cdpCommand` allowlist,
  domain enables, network/error ring buffers, dialog state).
- Preload/typing: `apps/desktop/src/preload.ts`,
  `apps/renderer/src/lib/bridge.ts`.
- Snapshot builder + ref store + new command handlers:
  `apps/renderer/src/components/browser-pane.tsx`.
- Wire: `packages/contracts/src/browser.ts` (`FillForm`, `Network`, `Dialog`,
  extended `Wait`/`Screenshot`).
- Tools + policy: `apps/server/src/provider/drivers/browser-tools.ts`,
  `drivers/claude.ts` (`READ_ONLY_TOOLS`).

## Risks / verification notes

- **`getFullAXTree` over Electron's debugger** — Accessibility is formally an
  experimental CDP domain. Expected to work (the attached debugger speaks the
  running Chromium's full protocol); if it throws, the renderer silently
  falls back to the v1 snapshot. Verify on a real page, and on a page inside
  an iframe.
- **Snapshot size** — big pages produce big trees. Prune ignored/generic
  nodes, cap output (~15k chars) with an explicit truncation note so the
  model knows to scroll/re-read rather than trust a silent cut.
- **Dialogs in `<webview>`** — Electron's handling of `alert()`/`confirm()`
  inside webviews differs from BrowserWindows. `Page.handleJavaScriptDialog`
  is best-effort; verify empirically, keep the 30s bridge deadline as the
  backstop so a stuck dialog fails the tool cleanly.
- **backendNodeId staleness** — refs die on navigation or DOM rebuild. Every
  ref-resolution failure returns "re-snapshot the page first," same contract
  as v1.
- **Desktop Electron 33 / `<webview>` deprecation risk** — the desktop package
  currently depends on Electron `^33.2.0`, and Electron discourages the tag;
  WebContentsView is the sanctioned replacement. We stay: the tag composites
  in-page (the cursor/shutter overlays depend on that) and the entire CDP seam
  is `WebContents`-level, so a future migration moves the hosting surface, not
  the agent plumbing.

## How to verify end-to-end

1. **Snapshot**: `"open example.com and snapshot"` → tree with roles/names,
   `ref=eN` on the link; click by ref lands with cursor glide (real CDP).
2. **Verification loop**: edit a local dev page to add a button; ask the
   agent to verify → it should navigate, wait, snapshot, and assert the
   button exists without taking a screenshot.
3. **Errors**: on a page that throws in a click handler, click it →
   `browser_console` reports the uncaught exception.
4. **Network**: `browser_network` lists the page's requests; drilling into a
   JSON API call shows status + truncated body.
5. **Form**: `browser_fill_form` fills email + password + a select in one
   permission prompt; a follow-up snapshot shows the values.
6. **Full page**: `fullPage: true` screenshot of a long page captures below
   the fold; the viewport variant still flashes the shutter.
