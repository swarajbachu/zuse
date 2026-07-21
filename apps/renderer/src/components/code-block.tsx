import { useEffect, useMemo, useRef, useState } from "react";
import type { BundledLanguage } from "shiki";
import { useResolvedAppearance } from "~/lib/appearance.tsx";
import { highlightCode } from "~/lib/highlight-worker.ts";
import {
	DARK_SHIKI_THEME,
	LIGHT_SHIKI_THEME,
	SHIKI_LANGUAGES,
} from "~/lib/shiki-config.ts";
import { cn } from "~/lib/utils";
import { CopyButton } from "./copy-button.tsx";
import { FileIcon } from "./file-icon.tsx";

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
	if (SHIKI_LANGUAGES.includes(normalized as BundledLanguage)) {
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
  /**
   * "framed" (default) shows the filename header bar — right for tool-result
   * file viewers. "plain" is for markdown fences: no header, just a rounded
   * code surface with a copy button that appears on hover.
   */
  readonly variant?: "framed" | "plain";
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
  variant = "framed",
}: Props) {
  const resolvedAppearance = useResolvedAppearance();
	const theme =
		resolvedAppearance === "dark" ? DARK_SHIKI_THEME : LIGHT_SHIKI_THEME;
  const lang = useMemo(
    () => langForLanguage(language) ?? langForFilename(filename),
    [filename, language],
  );
  const safeText = useMemo(
    () =>
      text.length > MAX_HIGHLIGHT_BYTES
				? `${text.slice(0, MAX_HIGHLIGHT_BYTES)}\n… (truncated)`
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
		void highlightCode({ code: safeText, lang, theme })
			.then((out) => {
				if (!cancelled) setHtml(out);
      })
      .catch(() => {
        if (cancelled) return;
        setHtml(null);
      });
    return () => {
      cancelled = true;
    };
  }, [safeText, lang, theme]);

  const name = title ?? basename(filename);

  return (
    <div
      className={cn(
        "group/code relative overflow-hidden border",
        variant === "plain" ? "rounded-xl" : "rounded-lg",
        isError ? "border-alert-error-bg" : "border-border/50",
      )}
    >
      {variant === "framed" ? (
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
        </div>
      ) : (
        <CopyButton
          text={text}
          label="Copy code"
          className="absolute end-1.5 top-1.5 z-10 size-6 rounded-md bg-message-pre-bg/80 text-muted-foreground opacity-0 backdrop-blur-sm transition-opacity hover:bg-muted hover:text-foreground focus-visible:opacity-100 group-hover/code:opacity-100"
        />
      )}
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
