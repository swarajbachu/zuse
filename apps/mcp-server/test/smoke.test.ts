import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { startServerHandle } from "../src/handle.ts";
import { buildTools } from "../src/tools.ts";

describe("MCP server smoke (standalone index for external agents)", () => {
  it("constructs a handle and exposes the full tool surface (including hybrid code_search)", async () => {
    const root = mkdtempSync(join(tmpdir(), "mz-mcp-"));
    try {
      writeFileSync(
        join(root, "thing.ts"),
        "export function thing() { return 42; }\n",
      );

      const handle = await startServerHandle({
        workspace: root,
        branch: "test",
      });
      await handle.reindex();

      const tools = buildTools(handle);
      const names = tools.map((t) => t.name).sort();
      expect(names).toEqual([
        "code_search",
        "find_references",
        "index_status",
        "list_module",
        "read_chunk",
        "reindex",
        "symbol_lookup",
      ]);

      const lookup = tools.find((t) => t.name === "symbol_lookup")!;
      const validated = lookup.validator.parse({ name: "thing", limit: 3 });
      const out = await lookup.handler(validated);
      expect(out.isError).toBeFalsy();
      const payload = JSON.parse(out.content[0]!.text) as { hits: unknown[] };
      expect(Array.isArray(payload.hits)).toBe(true);
      expect(payload.hits.length).toBeGreaterThan(0);

      const status = tools.find((t) => t.name === "index_status")!;
      const statusOut = await status.handler({});
      const statusPayload = JSON.parse(statusOut.content[0]!.text) as {
        workspace: string;
        branch: string;
        populated: boolean;
        stats: { blobs: number };
      };
      expect(statusPayload.workspace).toBe(root);
      expect(statusPayload.branch).toBe("test");
      expect(statusPayload.populated).toBe(true);
      expect(statusPayload.stats.blobs).toBeGreaterThan(0);

      // Exercise the newly-wired hybrid search path (non-symbol query → BM25)
      const cs = tools.find((t) => t.name === "code_search")!;
      const csValidated = cs.validator.parse({ query: "thing", kind: "text", limit: 3 });
      const csOut = await cs.handler(csValidated);
      expect(csOut.isError).toBeFalsy();
      const csPayload = JSON.parse(csOut.content[0]!.text) as { hits: unknown[] };
      expect(Array.isArray(csPayload.hits)).toBe(true);
      // The tiny file contains the identifier, so we should get at least one hit
      expect(csPayload.hits.length).toBeGreaterThan(0);

      await handle.close();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects malformed tool input", async () => {
    const root = mkdtempSync(join(tmpdir(), "mz-mcp-bad-"));
    try {
      writeFileSync(join(root, "a.ts"), "export const a = 1;\n");
      const handle = await startServerHandle({ workspace: root, branch: "main" });
      await handle.reindex();
      const tools = buildTools(handle);
      const read = tools.find((t) => t.name === "read_chunk")!;
      const bad = read.validator.safeParse({ chunkId: "not-a-number" });
      expect(bad.success).toBe(false);
      await handle.close();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
