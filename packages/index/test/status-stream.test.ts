import { describe, expect, it } from "vitest";
import { Effect, Fiber, Layer, ManagedRuntime, Stream } from "effect";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  IndexConfigTag,
  IndexService,
  IndexServiceLive,
  type IndexStatus,
} from "../src/index.ts";

describe("IndexService.statusStream", () => {
  it("emits the indexing → ready sequence during a reindex", async () => {
    const root = mkdtempSync(join(tmpdir(), "mz-status-"));
    try {
      writeFileSync(
        join(root, "a.ts"),
        "export function alpha() { return 1; }\n",
      );
      writeFileSync(
        join(root, "b.ts"),
        "export const beta = (n: number) => n * 2;\n",
      );

      const layer = IndexServiceLive.pipe(
        Layer.provide(
          Layer.succeed(IndexConfigTag, {
            root,
            branch: "main",
            dbPath: ":memory:",
          }),
        ),
      );
      const runtime = ManagedRuntime.make(layer);

      const collected: Array<IndexStatus["state"]> = [];

      // Subscribe first, then trigger the reindex. The first emit should be
      // the current "idle" snapshot, then "indexing" (possibly with progress
      // ticks if the corpus is large), then "ready" once the run settles.
      const fiber = runtime.runFork(
        Effect.flatMap(IndexService, (svc) =>
          Stream.runForEach(svc.statusStream, (s) =>
            Effect.sync(() => {
              if (
                collected[collected.length - 1] !== s.state ||
                collected.length === 0
              ) {
                collected.push(s.state);
              }
            }),
          ),
        ),
      );

      // Yield so the subscriber registers before we start the reindex.
      await new Promise((res) => setTimeout(res, 20));

      await runtime.runPromise(
        Effect.flatMap(IndexService, (svc) => svc.reindex()),
      );

      // Give the in-flight emissions a moment to settle before we tear the
      // fiber down.
      await new Promise((res) => setTimeout(res, 50));
      await runtime.runPromise(Fiber.interrupt(fiber));
      await runtime.dispose();

      expect(collected).toContain("indexing");
      expect(collected[collected.length - 1]).toBe("ready");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
