import { tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";

import type { BrowserCommand, BrowserCommandResult } from "@zuse/wire";

/**
 * Promise-returning send bound to one agent session. Provider-service closes
 * over the session id and the Effect runtime so these tool handlers — which
 * the Claude SDK invokes as plain async functions — stay free of any Effect
 * wiring.
 */
export type BrowserSend = (
  command: BrowserCommand,
) => Promise<BrowserCommandResult>;

/**
 * Standard text tool result from a command outcome: the `detail` note on
 * success (or `fallback`), or the `error` with `isError` on failure.
 */
const textResult = (result: BrowserCommandResult, fallback: string) => ({
  content: [
    {
      type: "text" as const,
      text: result.ok
        ? (result.detail ?? fallback)
        : (result.error ?? "Action failed."),
    },
  ],
  ...(result.ok ? {} : { isError: true as const }),
});

/**
 * Build the in-process MCP tool definitions for the agent browser. They drive
 * the app's existing on-screen `<webview>` (round-tripping through the
 * renderer) rather than spinning up a headless Chrome, so the user watches
 * every action live. v2 surface: a11y-tree snapshot + ref targeting, network
 * and console observability, batch form fill, dialogs, full-page capture.
 *
 * Descriptions are blunt on purpose — the model reads them to choose the
 * browser over `WebFetch`: this one renders JS, shows the user what's
 * happening, and can screenshot what it sees. They also steer the model into
 * the verification loop: navigate → wait → snapshot → act → console/network.
 */
export const buildBrowserTools = (send: BrowserSend) => [
  tool(
    "browser_navigate",
    "Open a URL in the app's in-app browser (the Browser tab the user can see). Use this — not WebFetch — when you need to render a real page (JS apps, dev servers, dashboards) or are about to screenshot or interact with it. The page loads in the shared on-screen webview so the user watches live. Returns the final URL and page title once the page settles.",
    {
      url: z
        .string()
        .min(1)
        .describe(
          "Absolute URL to load. Include the scheme (https:// or http:// for localhost dev servers).",
        ),
    },
    async (args) => {
      const result = await send({ _tag: "Navigate", url: args.url });
      if (!result.ok) {
        return {
          content: [
            {
              type: "text" as const,
              text: result.error ?? "Navigation failed.",
            },
          ],
          isError: true,
        };
      }
      const title = result.title ?? "";
      const finalUrl = result.url ?? args.url;
      return {
        content: [
          {
            type: "text" as const,
            text: `Loaded ${finalUrl}${title.length > 0 ? ` — "${title}"` : ""}.`,
          },
        ],
      };
    },
  ),

  tool(
    "browser_screenshot",
    "Capture what the in-app browser is showing and return it as an image you can see. Default is the visible viewport; set `fullPage: true` to capture the whole scrollable page. The user sees a camera-shutter flash when this fires. Prefer browser_snapshot for reading page structure/content — it's far cheaper; screenshot only when layout or visuals matter. Navigate first if nothing is loaded.",
    {
      fullPage: z
        .boolean()
        .optional()
        .describe(
          "Capture the entire page height, not just the viewport. Falls back to the viewport if the debugger is unavailable.",
        ),
    },
    async (args) => {
      const result = await send({
        _tag: "Screenshot",
        ...(args.fullPage !== undefined ? { fullPage: args.fullPage } : {}),
      });
      if (!result.ok || result.screenshot === undefined) {
        return {
          content: [
            {
              type: "text" as const,
              text:
                result.error ??
                "Could not capture a screenshot — make sure a page is loaded in the Browser tab.",
            },
          ],
          isError: true,
        };
      }
      return {
        content: [
          {
            type: "image" as const,
            data: result.screenshot,
            mimeType: "image/png" as const,
          },
        ],
      };
    },
  ),

  tool(
    "browser_snapshot",
    "Snapshot the current page as an accessibility tree: headings, landmarks, text, and every interactive element (links, buttons, inputs, …) with its role, accessible name, state, and a `ref=eN` you target with click/type/etc. Covers the whole document, not just the viewport. Read this BEFORE acting — you target elements by `ref`, never by coordinates — and re-snapshot after the page changes (refs go stale on navigation/re-render). Cheaper and more reliable than a screenshot.",
    {},
    async () => {
      const result = await send({ _tag: "Snapshot" });
      if (!result.ok || result.snapshot === undefined) {
        return {
          content: [
            {
              type: "text" as const,
              text: result.error ?? "Could not snapshot the page.",
            },
          ],
          isError: true,
        };
      }
      return {
        content: [{ type: "text" as const, text: result.snapshot }],
      };
    },
  ),

  tool(
    "browser_click",
    "Click an element by the `ref` you got from browser_snapshot. Also pass `element` — a short human-readable description of what you're clicking — so the user's approval prompt is legible. Re-snapshot first if the page changed — refs are only valid for the snapshot that produced them. Requires user approval.",
    {
      ref: z
        .string()
        .min(1)
        .describe(
          "The `ref` of the target element from a recent browser_snapshot.",
        ),
      element: z
        .string()
        .optional()
        .describe(
          'Human-readable description of the target, e.g. "the Sign in button".',
        ),
    },
    async (args) => {
      const result = await send({ _tag: "Click", ref: args.ref });
      return {
        content: [
          {
            type: "text" as const,
            text: result.ok
              ? (result.detail ?? `Clicked ${args.element ?? args.ref}.`)
              : (result.error ?? "Click failed."),
          },
        ],
        ...(result.ok ? {} : { isError: true }),
      };
    },
  ),

  tool(
    "browser_type",
    "Type text into the input/textarea identified by `ref` (from browser_snapshot). Replaces the field's current value. Set `submit: true` to press Enter afterward (submit a search box or login form). Pass `element` describing the field for a legible approval prompt. For several fields at once, prefer browser_fill_form — one approval instead of one per field. Requires user approval.",
    {
      ref: z
        .string()
        .min(1)
        .describe(
          "The `ref` of the target input from a recent browser_snapshot.",
        ),
      text: z.string().describe("The text to type into the field."),
      submit: z
        .boolean()
        .optional()
        .describe("Press Enter after typing (e.g. to submit the form)."),
      element: z
        .string()
        .optional()
        .describe(
          'Human-readable description of the field, e.g. "the email field".',
        ),
    },
    async (args) => {
      const result = await send({
        _tag: "Type",
        ref: args.ref,
        text: args.text,
        ...(args.submit !== undefined ? { submit: args.submit } : {}),
      });
      return {
        content: [
          {
            type: "text" as const,
            text: result.ok
              ? (result.detail ?? `Typed into ${args.element ?? args.ref}.`)
              : (result.error ?? "Type failed."),
          },
        ],
        ...(result.ok ? {} : { isError: true }),
      };
    },
  ),

  tool(
    "browser_wait",
    "Pause for the page to settle after a navigation or AJAX update. Give `selector` to wait until a CSS selector appears, `text` to wait until that text is visible on the page, or `ms` for a fixed delay. `timeoutMs` bounds the selector/text poll (default 10s, max 25s). Use sparingly — prefer re-snapshotting.",
    {
      ms: z.number().int().positive().max(15000).optional(),
      selector: z.string().min(1).optional(),
      text: z
        .string()
        .min(1)
        .optional()
        .describe(
          "Wait until this exact text appears in the page's visible text.",
        ),
      timeoutMs: z
        .number()
        .int()
        .positive()
        .max(25000)
        .optional()
        .describe(
          "How long to keep polling for `selector`/`text` (default 10000).",
        ),
    },
    async (args) => {
      const result = await send({
        _tag: "Wait",
        ...(args.ms !== undefined ? { ms: args.ms } : {}),
        ...(args.selector !== undefined ? { selector: args.selector } : {}),
        ...(args.text !== undefined ? { text: args.text } : {}),
        ...(args.timeoutMs !== undefined ? { timeoutMs: args.timeoutMs } : {}),
      });
      return {
        content: [
          {
            type: "text" as const,
            text: result.ok
              ? (result.detail ?? "Done waiting.")
              : (result.error ?? "Wait failed."),
          },
        ],
        ...(result.ok ? {} : { isError: true }),
      };
    },
  ),

  tool(
    "browser_scroll",
    "Scroll the page. Use `direction` (down/up/top/bottom) to move the viewport, or pass a `ref` from browser_snapshot to scroll that element into view. Snapshot again after scrolling — new elements may have come into view with fresh refs.",
    {
      direction: z.enum(["up", "down", "top", "bottom"]).optional(),
      ref: z
        .string()
        .optional()
        .describe(
          "Scroll this snapshot ref into view instead of moving the viewport.",
        ),
    },
    async (args) => {
      const result = await send({
        _tag: "Scroll",
        ...(args.direction !== undefined ? { direction: args.direction } : {}),
        ...(args.ref !== undefined ? { ref: args.ref } : {}),
      });
      return textResult(result, "Scrolled.");
    },
  ),

  tool(
    "browser_hover",
    "Hover the pointer over an element by `ref` (from browser_snapshot) to reveal hover menus, tooltips, or lazy content. Snapshot again afterward to pick up anything that appeared.",
    { ref: z.string().min(1) },
    async (args) => {
      const result = await send({ _tag: "Hover", ref: args.ref });
      return textResult(result, `Hovered ${args.ref}.`);
    },
  ),

  tool(
    "browser_select",
    "Choose an option in a <select> dropdown identified by `ref` (from browser_snapshot). `value` matches either the option's value or its visible label. Pass `element` describing the dropdown for a legible approval prompt. Requires user approval.",
    {
      ref: z.string().min(1),
      value: z.string().describe("The option value or visible text to select."),
      element: z
        .string()
        .optional()
        .describe('Human-readable description, e.g. "the country dropdown".'),
    },
    async (args) => {
      const result = await send({
        _tag: "Select",
        ref: args.ref,
        value: args.value,
      });
      return textResult(result, `Selected "${args.value}".`);
    },
  ),

  tool(
    "browser_press",
    "Press a keyboard key — Enter, Tab, Escape, ArrowDown, Backspace, etc. Targets the element `ref` if given, otherwise whatever is currently focused. Good for submitting, dismissing in-page overlays, or keyboard navigation (for native alert/confirm dialogs use browser_dialog). Requires user approval.",
    {
      key: z
        .string()
        .min(1)
        .describe(
          "Key name, e.g. Enter, Tab, Escape, ArrowDown, PageDown, Backspace.",
        ),
      ref: z.string().optional(),
      element: z
        .string()
        .optional()
        .describe("Human-readable description of the target element, if any."),
    },
    async (args) => {
      const result = await send({
        _tag: "Press",
        key: args.key,
        ...(args.ref !== undefined ? { ref: args.ref } : {}),
      });
      return textResult(result, `Pressed ${args.key}.`);
    },
  ),

  tool(
    "browser_read",
    "Read the visible text of the page (or of one element by `ref`). Use this — instead of a screenshot — to confirm content, read results, or verify a flow worked. Returns plain text, truncated if very long.",
    { ref: z.string().optional() },
    async (args) => {
      const result = await send({
        _tag: "Read",
        ...(args.ref !== undefined ? { ref: args.ref } : {}),
      });
      if (!result.ok) {
        return {
          content: [
            {
              type: "text" as const,
              text: result.error ?? "Could not read the page.",
            },
          ],
          isError: true,
        };
      }
      return {
        content: [{ type: "text" as const, text: result.text ?? "(no text)" }],
      };
    },
  ),

  tool(
    "browser_history",
    "Navigate the browser's own history: go back, go forward, or reload the current page. Waits for the page to settle.",
    { action: z.enum(["back", "forward", "reload"]) },
    async (args) => {
      const result = await send({ _tag: "History", action: args.action });
      return textResult(result, `Did ${args.action}.`);
    },
  ),

  tool(
    "browser_console",
    "Return the page's recent console messages, uncaught JavaScript exceptions, and load failures (captured since the last navigation), plus a note if a JS dialog is blocking the page. Check this after acting on a page — it's how you catch the error the UI didn't show. Use with browser_network to verify a page is healthy.",
    {},
    async () => {
      const result = await send({ _tag: "Console" });
      if (!result.ok) {
        return {
          content: [
            {
              type: "text" as const,
              text: result.error ?? "Could not read the console.",
            },
          ],
          isError: true,
        };
      }
      return {
        content: [
          {
            type: "text" as const,
            text:
              result.text && result.text.length > 0
                ? result.text
                : "(console is empty — no messages or errors since the last navigation)",
          },
        ],
      };
    },
  ),

  tool(
    "browser_network",
    "List the network requests the page has made since its last load (method, status, type, URL, id), or pass `id` to inspect one request's response headers and a truncated body. Use it to verify API calls succeeded, spot 4xx/5xx failures, or read a response the page didn't render. `filter` substring-matches URLs.",
    {
      filter: z
        .string()
        .optional()
        .describe("Only list requests whose URL contains this substring."),
      id: z
        .string()
        .optional()
        .describe(
          "Request id from a previous listing — returns that request's detail.",
        ),
    },
    async (args) => {
      const result = await send({
        _tag: "Network",
        ...(args.filter !== undefined ? { filter: args.filter } : {}),
        ...(args.id !== undefined ? { id: args.id } : {}),
      });
      if (!result.ok) {
        return {
          content: [
            {
              type: "text" as const,
              text: result.error ?? "Could not read network activity.",
            },
          ],
          isError: true,
        };
      }
      return {
        content: [
          {
            type: "text" as const,
            text:
              result.text && result.text.length > 0
                ? result.text
                : "(no requests captured since the last page load)",
          },
        ],
      };
    },
  ),

  tool(
    "browser_fill_form",
    "Fill several form fields in one action — text inputs, textareas, and <select> dropdowns, each identified by a `ref` from browser_snapshot. One approval covers the whole form, and the user watches the cursor move field to field. Set `submit: true` to press Enter in the last field afterward. Prefer this over repeated browser_type calls. Requires user approval.",
    {
      fields: z
        .array(
          z.object({
            ref: z
              .string()
              .min(1)
              .describe("The field's `ref` from a recent browser_snapshot."),
            value: z
              .string()
              .describe(
                "Text to fill, or the option value/label for a <select>.",
              ),
            element: z
              .string()
              .optional()
              .describe('Human-readable description, e.g. "the email field".'),
          }),
        )
        .min(1)
        .describe("Fields to fill, in order."),
      submit: z
        .boolean()
        .optional()
        .describe("Press Enter in the last field after filling everything."),
    },
    async (args) => {
      const result = await send({
        _tag: "FillForm",
        fields: args.fields.map((f) => ({ ref: f.ref, value: f.value })),
        ...(args.submit !== undefined ? { submit: args.submit } : {}),
      });
      return textResult(result, `Filled ${args.fields.length} fields.`);
    },
  ),

  tool(
    "browser_dialog",
    "Resolve the JavaScript dialog (alert/confirm/prompt) currently blocking the page: accept or dismiss it, with optional `promptText` to answer a prompt(). browser_console tells you when a dialog is open and what it says. Requires user approval.",
    {
      action: z.enum(["accept", "dismiss"]),
      promptText: z
        .string()
        .optional()
        .describe("Answer text when accepting a prompt() dialog."),
    },
    async (args) => {
      const result = await send({
        _tag: "Dialog",
        action: args.action,
        ...(args.promptText !== undefined
          ? { promptText: args.promptText }
          : {}),
      });
      return textResult(result, `Dialog ${args.action}ed.`);
    },
  ),

  tool(
    "browser_login",
    "Fill and submit the saved TEST login for a site, using the dummy credentials the user configured in Settings → Browser. Pass the site's origin (e.g. https://app.example.com). You never see or handle the password — it's injected directly into the page. The user is always asked to approve. Navigate to the login page first. Returns whether a saved credential was found and submitted.",
    {
      origin: z
        .string()
        .min(1)
        .describe(
          "The site origin to log into, e.g. https://app.example.com. Must match a credential saved in Settings → Browser.",
        ),
    },
    async (args) => {
      const result = await send({ _tag: "Login", origin: args.origin });
      return {
        content: [
          {
            type: "text" as const,
            text: result.ok
              ? (result.detail ??
                `Submitted the saved login for ${args.origin}.`)
              : (result.error ??
                `No saved credential for ${args.origin}. Ask the user to add one in Settings → Browser.`),
          },
        ],
        ...(result.ok ? {} : { isError: true }),
      };
    },
  ),
];
