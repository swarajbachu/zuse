import { describe, expect, it } from "vitest";
import { Effect } from "effect";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { bm25Search } from "../src/retrieval/bm25.ts";
import { closeIndexDb, openIndexDb } from "../src/db/sqlite.ts";
import { indexRepo } from "../src/indexer.ts";
import { reciprocalRankFusion } from "../src/retrieval/rrf.ts";
import { route } from "../src/retrieval/router.ts";
import { runMigrations } from "../src/schema/migrations.ts";

const run = <A, E>(eff: Effect.Effect<A, E>): Promise<A> =>
  Effect.runPromise(eff as Effect.Effect<A, E, never>);

describe("Phase C — BM25 + RRF + router", () => {
  it("router picks the right tiers per query shape", () => {
    expect(route("IndexService")).toEqual(["symbol"]);
    expect(route("addUser")).toEqual(["symbol"]);
    expect(route("const x = () => {}")).toEqual(["symbol", "bm25"]);
    // Vector tier is dropped under the default NullProvider — see router.ts
    // for the kill-switch rationale. When a real embedding provider lands
    // this assertion should become ["bm25", "vector"].
    expect(route("where does the pty service stream output")).toEqual([
      "bm25",
    ]);
  });

  it("reciprocal rank fusion sums per-source ranks", () => {
    const a = [{ chunkId: 1 }, { chunkId: 2 }, { chunkId: 3 }];
    const b = [{ chunkId: 3 }, { chunkId: 4 }, { chunkId: 1 }];
    const fused = reciprocalRankFusion([a, b], { k: 60 });
    // chunkId 1 appears at rank 1 in a, rank 3 in b → 1/61 + 1/63
    // chunkId 3 appears at rank 3 in a, rank 1 in b → 1/63 + 1/61
    // They should tie with the highest score.
    expect(fused.slice(0, 2).map((f) => f.chunkId).sort()).toEqual([1, 3]);
    expect(fused[0]!.score).toBeGreaterThan(fused[2]!.score);
  });

  it("BM25 finds chunks by token content", async () => {
    const root = mkdtempSync(join(tmpdir(), "mz-bm25-"));
    try {
      mkdirSync(join(root, "src"), { recursive: true });
      writeFileSync(
        join(root, "src/hello.ts"),
        "export function greet(name: string) {\n  return `hello ${name}`;\n}\n",
      );
      writeFileSync(
        join(root, "src/bye.ts"),
        "export function farewell(name: string) {\n  return `bye ${name}`;\n}\n",
      );

      const db = await run(openIndexDb(":memory:"));
      await run(runMigrations(db));
      await run(indexRepo(db, root, "main"));

      const hits = await run(bm25Search(db, "farewell", "main", 5));
      const top = hits.find((h) => h.content.includes("farewell"));
      expect(top).toBeDefined();
      expect(top!.file).toBe("src/bye.ts");

      await run(closeIndexDb(db));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
