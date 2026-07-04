import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import type { Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { tags as t } from "@lezer/highlight";

// Palette aligned with app CSS variables so appearance changes update existing
// editor instances without remounting CodeMirror.
const PALETTE = {
  bg: "transparent",
  fg: "var(--foreground)",
  mutedFg: "var(--muted-foreground)",
  faintBorder: "var(--border)",
  selection: "color-mix(in oklab, var(--primary) 22%, transparent)",
  cursor: "var(--foreground)",
  activeLine: "color-mix(in oklab, var(--foreground) 4%, transparent)",
  activeLineGutter: "color-mix(in oklab, var(--foreground) 6%, transparent)",
  matchingBracket: "color-mix(in oklab, var(--primary) 26%, transparent)",

  // Syntax
  keyword: "var(--syntax-keyword)",
  control: "var(--syntax-keyword)",
  string: "var(--syntax-string)",
  number: "var(--syntax-number)",
  bool: "var(--syntax-number)",
  function: "var(--syntax-function)",
  variable: "var(--foreground)",
  property: "var(--foreground)",
  type: "var(--syntax-type)",
  className: "var(--syntax-type)",
  attribute: "var(--syntax-attribute)",
  tag: "var(--syntax-tag)",
  punctuation: "var(--muted-foreground)",
  comment: "var(--muted-foreground)",
  meta: "var(--muted-foreground)",
  operator: "var(--muted-foreground)",
  link: "var(--syntax-function)",
  heading: "var(--message-heading)",
  invalid: "var(--destructive)",
};

const editorTheme = EditorView.theme(
  {
    "&": {
      height: "100%",
      backgroundColor: PALETTE.bg,
      color: PALETTE.fg,
      fontSize: "13px",
    },
    ".cm-scroller": {
      fontFamily:
        "'Geist Mono Variable', ui-monospace, SFMono-Regular, Menlo, monospace",
      lineHeight: "1.55",
    },
    ".cm-content": {
      caretColor: PALETTE.cursor,
      padding: "8px 0",
    },
    ".cm-cursor, .cm-dropCursor": {
      borderLeftColor: PALETTE.cursor,
    },
    "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection":
      {
        backgroundColor: PALETTE.selection,
      },
    ".cm-activeLine": {
      backgroundColor: PALETTE.activeLine,
    },
    ".cm-activeLineGutter": {
      backgroundColor: PALETTE.activeLineGutter,
      color: PALETTE.fg,
    },
    ".cm-gutters": {
      backgroundColor: PALETTE.bg,
      color: PALETTE.mutedFg,
      borderRight: `1px solid ${PALETTE.faintBorder}`,
    },
    ".cm-lineNumbers .cm-gutterElement": {
      padding: "0 12px 0 8px",
      minWidth: "2.25em",
    },
    ".cm-foldGutter .cm-gutterElement": {
      color: PALETTE.mutedFg,
      opacity: 0.5,
    },
    ".cm-foldGutter .cm-gutterElement:hover": {
      opacity: 1,
    },
    ".cm-matchingBracket, &.cm-focused .cm-matchingBracket": {
      backgroundColor: PALETTE.matchingBracket,
      outline: "none",
    },
    ".cm-nonmatchingBracket": {
      color: PALETTE.invalid,
    },
    ".cm-tooltip": {
      backgroundColor: "var(--popover)",
      color: PALETTE.fg,
      border: `1px solid ${PALETTE.faintBorder}`,
      borderRadius: "6px",
    },
    ".cm-panels": {
      backgroundColor: "var(--popover)",
      color: PALETTE.fg,
    },
    ".cm-panels.cm-panels-bottom": {
      borderTop: `1px solid ${PALETTE.faintBorder}`,
    },
    ".cm-searchMatch": {
      backgroundColor: "rgba(251, 191, 36, 0.18)",
      outline: `1px solid rgba(251, 191, 36, 0.4)`,
    },
    ".cm-searchMatch.cm-searchMatch-selected": {
      backgroundColor: "rgba(251, 191, 36, 0.32)",
    },
  },
  { dark: true },
);

const highlightStyle = HighlightStyle.define([
  { tag: t.comment, color: PALETTE.comment, fontStyle: "italic" },
  { tag: t.lineComment, color: PALETTE.comment, fontStyle: "italic" },
  { tag: t.blockComment, color: PALETTE.comment, fontStyle: "italic" },
  { tag: t.docComment, color: PALETTE.comment, fontStyle: "italic" },

  { tag: t.keyword, color: PALETTE.keyword },
  { tag: t.controlKeyword, color: PALETTE.control },
  { tag: t.moduleKeyword, color: PALETTE.keyword },
  { tag: t.operatorKeyword, color: PALETTE.keyword },
  { tag: t.modifier, color: PALETTE.keyword },
  { tag: t.self, color: PALETTE.keyword },
  { tag: t.null, color: PALETTE.keyword },
  { tag: t.atom, color: PALETTE.bool },

  { tag: [t.string, t.special(t.string)], color: PALETTE.string },
  { tag: t.regexp, color: PALETTE.string },
  { tag: t.escape, color: PALETTE.number },

  { tag: t.number, color: PALETTE.number },
  { tag: t.bool, color: PALETTE.bool },

  {
    tag: [t.function(t.variableName), t.function(t.propertyName)],
    color: PALETTE.function,
  },
  { tag: t.definition(t.variableName), color: PALETTE.variable },
  { tag: t.variableName, color: PALETTE.variable },
  { tag: t.propertyName, color: PALETTE.property },

  { tag: [t.typeName, t.namespace], color: PALETTE.type },
  { tag: t.className, color: PALETTE.className },

  { tag: t.attributeName, color: PALETTE.attribute },
  { tag: t.attributeValue, color: PALETTE.string },
  { tag: t.tagName, color: PALETTE.tag },
  { tag: t.angleBracket, color: PALETTE.punctuation },

  {
    tag: [
      t.punctuation,
      t.separator,
      t.bracket,
      t.paren,
      t.brace,
      t.squareBracket,
    ],
    color: PALETTE.punctuation,
  },
  { tag: t.operator, color: PALETTE.operator },

  { tag: t.meta, color: PALETTE.meta },
  { tag: t.processingInstruction, color: PALETTE.meta },

  { tag: [t.url, t.link], color: PALETTE.link, textDecoration: "underline" },
  { tag: t.heading, color: PALETTE.heading, fontWeight: "600" },
  { tag: t.strong, fontWeight: "600" },
  { tag: t.emphasis, fontStyle: "italic" },
  { tag: t.strikethrough, textDecoration: "line-through" },
  { tag: t.quote, color: PALETTE.mutedFg },
  { tag: t.list, color: PALETTE.fg },

  { tag: t.invalid, color: PALETTE.invalid },
]);

export const memoizeTheme: Extension = [
  editorTheme,
  syntaxHighlighting(highlightStyle),
];
