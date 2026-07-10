import { Effect } from "effect";

import { IndexParseError } from "../errors.ts";
import { type LanguageId, type ParseResult } from "../types.ts";
import { jsonChunker } from "./json.ts";
import { markdownChunker } from "./markdown.ts";
import { treesitterChunker } from "./treesitter.ts";
import { windowChunker } from "./window.ts";

/**
 * For JS/TS we union the decl-anchored chunks (symbol-aware) with a
 * windowed pass (BM25-friendly). The two cover different retrieval modes:
 * the agent navigating to a function uses the decl chunk; the agent
 * searching for a string literal or a comment uses the window chunk.
 */
const combineForCode = (source: string, language: LanguageId): ParseResult => {
  const ts = treesitterChunker(source, language);
  const windowed = windowChunker(source);
  return {
    symbols: ts.symbols,
    chunks: [...ts.chunks, ...windowed.chunks],
  };
};

/**
 * Dispatch a source blob to the right chunker. Tree-sitter for the JS/TS
 * family; heading/structure-anchored chunkers for markdown/json; line
 * windows for everything else.
 *
 * Wrapped in `Effect.try` because tree-sitter can throw on truly malformed
 * input (we've seen it crash on partial UTF-16 — defensive). On failure we
 * fall back to the windowed chunker so the file still ends up retrievable.
 */
export const chunkSource = (
  path: string,
  source: string,
  language: LanguageId,
): Effect.Effect<ParseResult, IndexParseError> =>
  Effect.try({
    try: (): ParseResult => {
      switch (language) {
        case "typescript":
        case "tsx":
        case "javascript":
        case "jsx":
          return combineForCode(source, language);
        case "markdown":
          return markdownChunker(source);
        case "json":
          return jsonChunker(source);
        case "unknown":
        default:
          return windowChunker(source);
      }
    },
    catch: (cause) =>
      new IndexParseError({
        path,
        reason: `chunk failed for ${language}`,
        cause,
      }),
  }).pipe(
    Effect.catch(() => Effect.succeed(windowChunker(source))),
  );
