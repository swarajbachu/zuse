# Visual Plans

Turn the current Claude Code or Codex planning conversation into a visual HTML
plan with diagrams, implementation steps, tradeoffs and verification criteria.

1. Install from Settings → Extensions. Open an idle local conversation and the
   **Visual Plans** workspace tab.
2. Optionally edit **Customize plan instructions**. Click **Prepare visual plan**.
   The host requests Plan mode and attaches instructions. Add your task and
   submit through the normal composer. Unsupported/failed mode changes are shown.
3. When the agent returns a fenced HTML plan, click **Preview latest HTML**.
   The extension reads current-turn assistant/plan output, including provider
   plan messages. Incomplete HTML waits for a complete code block. You can also
   paste an HTML document or fenced block.
4. Describe revisions and choose **Attach revision feedback**. This attaches the
   exact previewed plan and your feedback; submit through the ordinary composer.
5. Approve implementation using the normal conversation workflow when ready.

The extension augments Plan mode; it does not replace the built-in selector or
silently rewrite every prompt. Providers may wrap the HTML in their required
Markdown plan format. Drawing quality depends on the selected agent. No extra
model service is called by the extension.

HTML is sanitized and rendered inside an empty-sandbox iframe with a restrictive
CSP. Inline SVG/CSS are supported; scripts, external resources, forms and links
are removed or blocked. The preview limit is 128 KiB. Previewing never approves
execution. Switching conversation/workspace clears incompatible panel state.

Requires extension API 1.1 and `ui`, `planning`, `attachments`. User-selected
instructions and feedback are immutable composer attachments. The sample under
`fixtures/` is synthetic QA data. Run `bun run test` and `bun run check-types`.
