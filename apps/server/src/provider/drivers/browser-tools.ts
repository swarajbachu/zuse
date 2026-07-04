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
 * every action live. Phase 1: navigate + screenshot. Interaction
 * (snapshot/click/type) and login arrive in later phases as new tools here.
 *
 * Descriptions are blunt on purpose — the model reads them to choose the
 * browser over `WebFetch`: this one renders JS, shows the user what's
 * happening, and can screenshot what it sees.
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
    "Capture what the in-app browser is currently showing (the visible viewport) and return it as an image you can see. The user sees a camera-shutter flash when this fires. Use it to verify a page rendered correctly, read content that didn't come through as text, or confirm the result of an action. Navigate first if nothing is loaded.",
    {},
    async () => {
      const result = await send({ _tag: "Screenshot" });
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
    "List the interactive and visible elements on the current page — links, buttons, inputs, etc. — each with a stable `ref`, its role, accessible name, and current value. Read this BEFORE clicking or typing: you target elements by `ref`, never by coordinates. Cheaper and more reliable than a screenshot for figuring out what's on the page and what to do next.",
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
    "Click an element by the `ref` you got from browser_snapshot. Re-snapshot first if the page changed — refs are only valid for the snapshot that produced them. Requires user approval.",
    {
      ref: z
        .string()
        .min(1)
        .describe(
          "The `ref` of the target element from a recent browser_snapshot.",
        ),
    },
    async (args) => {
      const result = await send({ _tag: "Click", ref: args.ref });
      return {
        content: [
          {
            type: "text" as const,
            text: result.ok
              ? (result.detail ?? `Clicked ${args.ref}.`)
              : (result.error ?? "Click failed."),
          },
        ],
        ...(result.ok ? {} : { isError: true }),
      };
    },
  ),

  tool(
    "browser_type",
    "Type text into the input/textarea identified by `ref` (from browser_snapshot). Replaces the field's current value. Set `submit: true` to press Enter afterward (submit a search box or login form). Requires user approval.",
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
              ? (result.detail ?? `Typed into ${args.ref}.`)
              : (result.error ?? "Type failed."),
          },
        ],
        ...(result.ok ? {} : { isError: true }),
      };
    },
  ),

  tool(
    "browser_wait",
    "Pause for the page to settle after a navigation or AJAX update. Give `selector` to wait until a CSS selector appears (up to ~10s), or `ms` for a fixed delay. Use sparingly — prefer re-snapshotting.",
    {
      ms: z.number().int().positive().max(15000).optional(),
      selector: z.string().min(1).optional(),
    },
    async (args) => {
      const result = await send({
        _tag: "Wait",
        ...(args.ms !== undefined ? { ms: args.ms } : {}),
        ...(args.selector !== undefined ? { selector: args.selector } : {}),
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
    "Choose an option in a <select> dropdown identified by `ref` (from browser_snapshot). `value` matches either the option's value or its visible label. Requires user approval.",
    {
      ref: z.string().min(1),
      value: z.string().describe("The option value or visible text to select."),
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
    "Press a keyboard key — Enter, Tab, Escape, ArrowDown, Backspace, etc. Targets the element `ref` if given, otherwise whatever is currently focused. Good for submitting, dismissing dialogs, or keyboard navigation. Requires user approval.",
    {
      key: z
        .string()
        .min(1)
        .describe(
          "Key name, e.g. Enter, Tab, Escape, ArrowDown, PageDown, Backspace.",
        ),
      ref: z.string().optional(),
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
    "Return the page's recent console messages and uncaught JavaScript errors (captured since the last navigation). Use this to verify a page is healthy or to debug why something didn't work.",
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
