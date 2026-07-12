import { Effect } from "effect";

import { getEmbeddingProvider } from "../embedding/provider.ts";
import { applyRerank } from "../rerank/index.ts";
import type { IndexDb } from "../db/sqlite.ts";
import { bm25Search } from "./bm25.ts";
import { reciprocalRankFusion } from "./rrf.ts";
import { route } from "./router.ts";
import {
  lookupSymbol,
  symbolHitToSearchHit,
} from "./symbol-lookup.ts";
import type { SymbolHit } from "../types.ts";
import { isVectorAvailable, vectorSearch } from "./vector.ts";
import type { SearchHit, SearchInput } from "../types.ts";

/**
 * Used by `search` to resolve a symbol to its enclosing chunk's id + content
 * so the agent gets actual code text, not just `function foo(...)`. Returns
 * `null` when the symbol has no anchored chunk (type aliases, properties).
 */
const fetchChunkBySymbol = (
  db: IndexDb,
  symbolId: number,
  branch: string,
): Effect.Effect<{ chunkId: number; content: string } | null, never> =>
  Effect.sync(() => {
    try {
      const row = db
        .prepare(
          `SELECT c.id, c.content FROM chunks c
           JOIN manifests m ON m.blob_id = c.blob_id AND m.branch = ?
           WHERE c.symbol_id = ?
           ORDER BY c.id ASC LIMIT 1`,
        )
        .get(branch, symbolId) as { id: number; content: string } | undefined;
      return row ? { chunkId: row.id, content: row.content } : null;
    } catch {
      return null;
    }
  });

/**
 * Hybrid search pipeline — routes the query into the tier(s) the router
 * recommends, runs them in parallel, fuses via RRF when more than one
 * tier fires. Symbol-only queries skip fusion entirely (single source,
 * RRF would be a no-op).
 *
 * This is the single source of truth used by both:
 *   - the Effect `IndexService` (in-process desktop / full runtime)
 *   - the lightweight direct-DB path in the standalone MCP server
 *
 * The implementation gracefully degrades:
 *   - when no embedding provider is configured (vector tier dropped by router)
 *   - when rerank provider is Null (RRF order is kept)
 */
export const search = (
  db: IndexDb,
  defaultBranch: string,
  input: SearchInput,
): Effect.Effect<ReadonlyArray<SearchHit>, never> =>
  Effect.gen(function* () {
    const branch = input.branch ?? defaultBranch;
    const limit = input.limit ?? 5;
    const pathGlob = input.pathGlob;
    const tiers = route(input.query, input.kind);

    const wantsSymbol = tiers.includes("symbol");
    const wantsBm25 = tiers.includes("bm25");
    const wantsVector = tiers.includes("vector");

    // Tier 1 — symbol lookup. Single-source path returns directly.
    const symbolHits = wantsSymbol
      ? yield* lookupSymbol(db, input.query, branch, undefined, 20, pathGlob).pipe(
          Effect.catch(() =>
            Effect.succeed([] as ReadonlyArray<ReturnType<typeof Object>>),
          ),
        )
      : [];

    if (tiers.length === 1 && wantsSymbol) {
      const out: SearchHit[] = [];
      for (const h of symbolHits.slice(0, limit) as ReadonlyArray<SymbolHit>) {
        const chunk = yield* fetchChunkBySymbol(db, h.symbolId, branch);
        out.push(
          symbolHitToSearchHit(h, chunk?.content ?? `${h.kind} ${h.name}`),
        );
      }
      return out as ReadonlyArray<SearchHit>;
    }

    // Tier 2 / Tier 3 — gather candidates, fuse via RRF.
    const fanout = 30;
    const rankings: ReadonlyArray<{ chunkId: number }>[] = [];

    if (wantsBm25) {
      const hits = yield* bm25Search(db, input.query, branch, fanout, pathGlob).pipe(
        Effect.catch(() => Effect.succeed([])),
      );
      rankings.push(hits);
    }
    if (wantsVector && isVectorAvailable(db)) {
      const provider = getEmbeddingProvider();
      if (provider.id !== "null") {
        const [vec] = yield* Effect.tryPromise({
          try: () => provider.embed([input.query]),
          catch: () => new Error("embed failed"),
        }).pipe(Effect.catch(() => Effect.succeed([new Float32Array(0)])));
        if (vec && vec.length > 0) {
          const hits = yield* vectorSearch(db, vec, branch, fanout, pathGlob).pipe(
            Effect.catch(() => Effect.succeed([])),
          );
          rankings.push(hits);
        }
      }
    }
    if (wantsSymbol && symbolHits.length > 0) {
      rankings.push(
        symbolHits.map((h) => ({
          chunkId: -1 - (h as { symbolId: number }).symbolId,
        })),
      );
    }

    // Over-fetch into RRF; we'll narrow with rerank before returning.
    const fanForRerank = Math.max(20, limit * 4);
    const fused = reciprocalRankFusion(rankings).slice(0, fanForRerank);
    const out: SearchHit[] = [];
    for (const { chunkId, score } of fused) {
      if (chunkId < 0) {
        // Symbol-derived placeholder id. Convert back, fetch its chunk.
        const symbolId = -1 - chunkId;
        const sh = (symbolHits as ReadonlyArray<SymbolHit>).find(
          (h) => h.symbolId === symbolId,
        );
        if (!sh) continue;
        const chunk = yield* fetchChunkBySymbol(db, symbolId, branch);
        out.push({
          ...symbolHitToSearchHit(sh, chunk?.content ?? `${sh.kind} ${sh.name}`),
          chunkId: chunk?.chunkId ?? -1,
          score,
          source: "fused",
        });
      } else {
        const row = yield* Effect.try({
          try: () =>
            db
              .prepare(
                `SELECT c.id, c.start_line, c.end_line, c.content, c.symbol_id, m.file_path
                 FROM chunks c
                 JOIN manifests m ON m.blob_id = c.blob_id AND m.branch = ?
                 WHERE c.id = ?`,
              )
              .get(branch, chunkId) as
              | {
                  id: number;
                  start_line: number;
                  end_line: number;
                  content: string;
                  symbol_id: number | null;
                  file_path: string;
                }
              | undefined,
          catch: () => new Error("fetch chunk failed"),
        }).pipe(Effect.catch(() => Effect.succeed(undefined)));
        if (!row) continue;
        out.push({
          chunkId: row.id,
          file: row.file_path,
          range: { start: row.start_line, end: row.end_line },
          symbol: null,
          content: row.content,
          score,
          source: "fused",
        });
      }
    }
    // Phase D: rerank the over-fetched fused candidates and trim to `limit`.
    // No-op when the active provider is NullRerankProvider (default), so
    // local installs without a paid backend still get the RRF ordering.
    const reranked = yield* Effect.tryPromise({
      try: () => applyRerank(input.query, out, limit),
      catch: () => new Error("rerank failed"),
    }).pipe(Effect.catch(() => Effect.succeed(out.slice(0, limit))));
    return reranked as ReadonlyArray<SearchHit>;
  });
