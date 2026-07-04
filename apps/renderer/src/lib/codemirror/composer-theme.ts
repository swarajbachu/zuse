import type { Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";

/**
 * Prose theme for the chat composer. Reads as a regular text input —
 * sans-serif font, no gutter, no active-line highlight. Auto-grow is the
 * container's job (min-height / max-height around the host element); the
 * editor only configures its own typography.
 */
export const composerTheme: Extension = EditorView.theme(
  {
    "&": {
      backgroundColor: "transparent",
      color: "inherit",
      fontSize: "13px",
    },
    "&.cm-focused": {
      outline: "none",
    },
    ".cm-scroller": {
      fontFamily:
        "ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Inter, sans-serif",
      lineHeight: "1.55",
      overflowX: "hidden",
    },
    ".cm-content": {
      padding: "8px 4px",
      caretColor: "currentColor",
    },
    ".cm-line": {
      padding: "0",
    },
    ".cm-placeholder": {
      color: "var(--muted-foreground, #71717a)",
      fontStyle: "normal",
    },
    "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection":
      {
        backgroundColor: "color-mix(in oklab, var(--primary) 22%, transparent)",
      },
  },
  { dark: true },
);
