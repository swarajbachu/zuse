# Inline HTML visualizations

Zuse exposes `html_preview` and `html_render` through its session-scoped app MCP gateway. Supported provider drivers, custom ACP agents, and native SDK MCP integrations share the same definitions. Providers without an app MCP connection do not gain these tools. Existing sessions receive the tools when their provider connection is recreated. Executable HTML tools follow the normal runtime approval policy and are not advertised as read-only.

`html_preview` takes a complete HTML document, an optional width (240–1600, default 728), and an optional appearance (`dark` or `light`, default `dark`). It returns a PNG, content/capture heights, and bounded console messages. `html_render` takes HTML, a title (1–200 characters), and an initial height (80–2000 pixels). It returns only `{ htmlRender: { attachmentId, title, height } }` after the document is stored.

Input HTML is limited to 512,000 UTF-8 bytes. Absolute workspace PNG/JPEG/GIF/WebP paths in quoted HTML/JavaScript strings and CSS URLs are embedded using the image tool's canonical-path checks. Up to 32 distinct images are allowed; the final embedded document is capped at 4 MiB, counting repeated images, to fit cloud attachment reads. Protocol-relative and root-relative asset URLs outside the workspace are left unchanged and never read from disk. Canonical workspace paths that escape through symlinks are rejected. Inline SVG works; SVG files are not automatically embedded.

## Rendering and persistence

Pages render at the publishing tool call's position, outside collapsed activity. Documents are ordinary session-owned attachments, and their tool-result messages pin them in `message_attachments` within the message dispatch transaction. Existing attachment storage and archive relocation apply. Reads use authenticated session-scoped attachment commands, including archived transcripts and cloud environments.

The renderer loads visuals near the viewport and keeps the mounted page through unrelated text updates. A shared bootstrap supplies CSS variables (`--background`, `--foreground`, `--muted`, `--muted-foreground`, `--primary`, `--border`, `--font-sans`) and reports height changes; content may grow beyond the initial height up to 2000 pixels. Theme changes update variables without reloading. Expansion opens another isolated view; transient JavaScript state is not shared between that view, the inline page, or a reopened conversation.

Public HTTP(S) assets are allowed and can fail offline. Published visuals require the protected desktop network capability; standalone browser views and older desktop builds show an unavailable state instead of executing unprotected HTML. Desktop requests from visual frames are redirected to dedicated asset schemes, then fetched through an ephemeral session and the same public-address SOCKS proxy used by previews. Only GET requests are forwarded, without application cookies, authorization, or request headers; public libraries, images, styles, fonts, and GET APIs are supported. Frame navigation is blocked. Non-proxied WebRTC UDP and QUIC are disabled to prevent alternate transports from bypassing this policy. Author pages run in an opaque-origin iframe with `allow-scripts` only. They have no app API bridge, same-origin privileges, popup permission, or top-level navigation permission. CSP disables forms, nested frames, workers, objects, and base-URL changes. Arbitrary ordinary Markdown HTML continues to use the existing sanitizer.

## Preview lifecycle

Playwright is loaded only on the first preview request. Chromium is downloaded lazily into Playwright's user cache, outside workspace data. A request made during installation receives a retry message; publishing remains available. Installation completion is checked before launching, so interrupted extraction cannot be mistaken for an installed browser. Desktop packaging retains the CLI and runtime files outside ASAR; the cloud distribution includes Playwright and Playwright Core.

Each server owns one browser, up to two active preview contexts, and eight queued requests. Requests have a 30-second deadline, including queue wait. Cancellation closes the context; server shutdown also stops installation and closes the browser and proxy. Console output is capped at 100 entries of 2000 characters; PNGs are capped at 4 MiB.

Preview traffic passes through a SOCKS proxy that rejects local, private, translated-private, metadata, and own-interface addresses. DNS results are checked and pinned for each connection, including redirected destinations. Browser flags prevent proxy bypass and non-proxied WebRTC/QUIC traffic. Contexts have no application cookies or saved credentials.

## Verification

- Agent tests: `html-tools.test.ts`, `mcp-gateway.test.ts`, and workspace-instruction tests.
- Server tests: `html-*` unit/integration tests plus attachment-scope and conversation-services tests.
- Client tests: `html-render.test.ts`, chat timeline tests, and attachment/envelope regressions.
- Published-network isolation: `xvfb-run -a node apps/desktop/test/integration/html-visual-network.mjs` on Linux (installed Electron and internet access required); validates public assets, private destinations, redirects, credential isolation, and navigation.
- Actual viewer: `node apps/renderer/test/integration/html-visual.browser.mjs` (uses `/usr/bin/google-chrome`, override with `CHROME_PATH`). Set `ZUSE_TEST_SCREENSHOT_DIR` to capture the wide/narrow fixture. `--serve` keeps the fixture server open for inspection.
- Server Chromium integration tests use `ZUSE_TEST_CHROME` or `/usr/bin/google-chrome`, without downloading a browser during tests.

The benchmark fixture contains illustrative data, not verified performance claims. Mobile rendering and persistent interactive state are outside this implementation.
