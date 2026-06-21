import { useEffect, useMemo, useRef, useState } from "react";
import {
  createHighlighter,
  type BundledLanguage,
  type Highlighter,
  type ThemeRegistration,
} from "shiki";

import { cn } from "~/lib/utils";
import { CopyButton } from "./copy-button.tsx";
import { FileIcon } from "./file-icon.tsx";

const THEME = "memoize-dark" as const;

const MEMOIZE_SHIKI_THEME: ThemeRegistration = {
  name: THEME,
  type: "dark",
  colors: {
    "editor.background": "#00000000",
    "editor.foreground": "#e4e4e7",
    "editorLineNumber.foreground": "#71717a",
    "editor.selectionBackground": "#a855f72e",
  },
  tokenColors: [
    {
      scope: ["comment", "punctuation.definition.comment"],
      settings: { foreground: "#71717a", fontStyle: "italic" },
    },
    {
      scope: ["keyword", "storage", "storage.type", "constant.language"],
      settings: { foreground: "#c084fc" },
    },
    {
      scope: ["string", "constant.character", "markup.inline.raw.string"],
      settings: { foreground: "#86efac" },
    },
    {
      scope: ["constant.numeric", "constant.language.boolean"],
      settings: { foreground: "#fbbf24" },
    },
    {
      scope: ["entity.name.function", "support.function", "variable.function"],
      settings: { foreground: "#7dd3fc" },
    },
    {
      scope: [
        "entity.name.type",
        "entity.name.class",
        "support.type",
        "support.class",
      ],
      settings: { foreground: "#67e8f9" },
    },
    {
      scope: ["entity.other.attribute-name", "variable.parameter"],
      settings: { foreground: "#fda4af" },
    },
    {
      scope: ["entity.name.tag", "support.class.component"],
      settings: { foreground: "#f87171" },
    },
    {
      scope: ["punctuation", "meta.brace", "keyword.operator"],
      settings: { foreground: "#a1a1aa" },
    },
    {
      scope: ["markup.heading", "entity.name.section"],
      settings: { foreground: "#fafafa", fontStyle: "bold" },
    },
    {
      scope: ["markup.link", "string.other.link"],
      settings: { foreground: "#7dd3fc", fontStyle: "underline" },
    },
    {
      scope: ["invalid", "invalid.illegal"],
      settings: { foreground: "#f87171" },
    },
  ],
};

/** Languages we eagerly load on highlighter init. Anything outside this set
 *  renders as plain text — Shiki throws if asked to highlight an unloaded
 *  language, so we keep the list tight and predictable. */
const LANGS: ReadonlyArray<BundledLanguage> = [
  "ts",
  "tsx",
  "js",
  "jsx",
  "json",
  "md",
  "html",
  "css",
  "python",
  "rust",
  "go",
  "bash",
  "shell",
  "yaml",
  "toml",
  "sql",
];

const langForExtension = (ext: string): BundledLanguage | null => {
  switch (ext) {
    case "ts":
      return "ts";
    case "tsx":
      return "tsx";
    case "js":
    case "cjs":
    case "mjs":
      return "js";
    case "jsx":
      return "jsx";
    case "json":
      return "json";
    case "md":
    case "mdx":
    case "markdown":
      return "md";
    case "html":
    case "htm":
      return "html";
    case "css":
    case "scss":
    case "sass":
      return "css";
    case "py":
      return "python";
    case "rs":
      return "rust";
    case "go":
      return "go";
    case "sh":
    case "zsh":
    case "bash":
      return "bash";
    case "yml":
    case "yaml":
      return "yaml";
    case "toml":
      return "toml";
    case "sql":
      return "sql";
    default:
      return null;
  }
};

const LANG_ALIASES: Readonly<Record<string, BundledLanguage>> = {
  cjs: "js",
  mjs: "js",
  javascript: "js",
  jsx: "jsx",
  mdx: "md",
  markdown: "md",
  py: "python",
  python3: "python",
  rs: "rust",
  rust: "rust",
  shell: "bash",
  shellscript: "bash",
  sh: "bash",
  zsh: "bash",
  typescript: "ts",
  yml: "yaml",
};

const langForLanguage = (
  language: string | undefined,
): BundledLanguage | null => {
  if (language === undefined) return null;
  const normalized = language
    .trim()
    .toLowerCase()
    .replace(/^language-/, "");
  if (normalized.length === 0) return null;
  const aliased = LANG_ALIASES[normalized];
  if (aliased !== undefined) return aliased;
  if (LANGS.includes(normalized as BundledLanguage)) {
    return normalized as BundledLanguage;
  }
  return langForExtension(normalized);
};

const langForFilename = (filename: string): BundledLanguage | null => {
  const slash = filename.lastIndexOf("/");
  const base = slash === -1 ? filename : filename.slice(slash + 1);
  const dot = base.lastIndexOf(".");
  if (dot === -1) return null;
  return langForExtension(base.slice(dot + 1).toLowerCase());
};

const basename = (p: string): string => {
  const i = p.lastIndexOf("/");
  return i === -1 ? p : p.slice(i + 1);
};

// Singleton highlighter — Shiki is expensive to initialize (loads WASM +
// grammar/theme bundles). One instance per renderer process, cached as a
// module-level Promise so concurrent first-render calls share the same
// init.
let highlighterPromise: Promise<Highlighter> | null = null;
const getHighlighter = (): Promise<Highlighter> => {
  highlighterPromise ??= createHighlighter({
    themes: [MEMOIZE_SHIKI_THEME],
    langs: [...LANGS],
  });
  return highlighterPromise;
};

/** Hard cap so a runaway agent reading a giant file doesn't lock the
 *  highlighter for seconds. The box has its own scrollbar; we just trim the
 *  text fed to Shiki. */
const MAX_HIGHLIGHT_BYTES = 200_000;

interface Props {
  readonly filename: string;
  readonly text: string;
  readonly language?: string;
  readonly title?: string;
  readonly maxHeight?: number;
  readonly isError?: boolean;
}

/**
 * Read-tool result viewer: a syntax-highlighted, scroll-capped code box with
 * a small file-icon header. Shiki provides the highlighting; we render to
 * HTML and inject it because that's cheaper than the React-ified renderer
 * for large payloads. Falls back to plain text while the highlighter loads
 * (first paint of the very first CodeBlock instance in the session).
 */
export function CodeBlock({
  filename,
  text,
  language,
  title,
  maxHeight = 420,
  isError = false,
}: Props) {
  const lang = useMemo(
    () => langForLanguage(language) ?? langForFilename(filename),
    [filename, language],
  );
  const safeText = useMemo(
    () =>
      text.length > MAX_HIGHLIGHT_BYTES
        ? text.slice(0, MAX_HIGHLIGHT_BYTES) + "\n… (truncated)"
        : text,
    [text],
  );

  const [html, setHtml] = useState<string | null>(null);
  // Re-run highlight on text/lang change. We swap the inner HTML imperatively
  // so React doesn't have to diff a 2000-line `<pre>` tree.
  const hostRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (lang === null) {
      setHtml(null);
      return;
    }
    let cancelled = false;
    void getHighlighter()
      .then((hl) => {
        if (cancelled) return;
        const out = hl.codeToHtml(safeText, {
          lang,
          theme: THEME,
          transformers: [
            {
              line(node, line) {
                node.properties["data-line"] = String(line);
              },
            },
          ],
        });
        setHtml(out);
      })
      .catch(() => {
        if (cancelled) return;
        setHtml(null);
      });
    return () => {
      cancelled = true;
    };
  }, [safeText, lang]);

  const name = title ?? basename(filename);
  const lineCount = safeText.length === 0 ? 0 : safeText.split("\n").length;

  return (
    <div
      className={cn(
        "overflow-hidden rounded-md border",
        isError ? "border-alert-error-bg" : "border-border/60",
      )}
    >
      <div className="flex items-center gap-2 border-b border-border/40 bg-muted px-2 py-1 text-[11px] text-muted-foreground">
        <FileIcon
          name={name}
          kind="file"
          className="inline-flex size-3.5 shrink-0 items-center justify-center"
        />
        <span className="min-w-0 flex-1 truncate font-mono text-foreground/80">
          {name}
        </span>
        <CopyButton
          text={text}
          label={`Copy ${name}`}
          className="size-5 rounded text-muted-foreground/60 hover:bg-muted/60"
        />
        <span className="tabular-nums opacity-70">
          {lineCount} {lineCount === 1 ? "line" : "lines"}
        </span>
      </div>
      <div
        ref={hostRef}
        className={cn(
          "code-block-scroll overflow-auto bg-message-pre-bg text-[12px] leading-[1.3]",
          isError ? "bg-alert-error-bg/40" : undefined,
        )}
        style={{ maxHeight }}
      >
        {html === null ? (
          <pre className="whitespace-pre overflow-x-auto px-3 py-2 font-mono text-[12px] text-foreground/80">
            {safeText || "(empty)"}
          </pre>
        ) : (
          <div
            className="code-block-shiki"
            // Shiki's output is trusted HTML — it escapes the source it
            // tokenizes and emits only its own span tree + theme inline
            // styles.
            dangerouslySetInnerHTML={{ __html: html }}
          />
        )}
      </div>
    </div>
  );
}
