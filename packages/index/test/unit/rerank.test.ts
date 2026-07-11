import { describe, expect, it } from "vitest";

import {
	applyRerank,
	getRerankProvider,
	NullRerankProvider,
	type RerankProvider,
	setRerankProvider,
} from "../../src/rerank/index.ts";
import type { SearchHit, SymbolKind } from "../../src/types.ts";

const mkHit = (i: number, content: string): SearchHit => ({
	chunkId: i,
	file: `f${i}.ts`,
	range: { start: 1, end: 10 },
	symbol: { name: `s${i}`, kind: "function" as SymbolKind },
	content,
	score: 0,
	source: "fused",
});

describe("Phase D — rerank pipeline", () => {
	it("Null provider preserves order and trims to topK", async () => {
		setRerankProvider(new NullRerankProvider());
		const hits = [mkHit(1, "foo"), mkHit(2, "bar"), mkHit(3, "baz")];
		const out = await applyRerank("anything", hits, 2);
		expect(out.length).toBe(2);
		expect(out[0]!.chunkId).toBe(1);
	});

	it("Custom provider re-sorts by returned scores", async () => {
		const swapping: RerankProvider = {
			id: "swap",
			// Reverse the order — last in becomes highest score.
			rerank: async (_q, docs) => docs.map((_, i) => i),
		};
		setRerankProvider(swapping);
		const hits = [mkHit(1, "a"), mkHit(2, "b"), mkHit(3, "c")];
		const out = await applyRerank("q", hits, 3);
		expect(out.map((h) => h.chunkId)).toEqual([3, 2, 1]);
		// Restore default so other tests are unaffected.
		setRerankProvider(new NullRerankProvider());
	});

	it("get/set provider round-trips", () => {
		const provider: RerankProvider = {
			id: "test",
			rerank: async () => [],
		};
		setRerankProvider(provider);
		expect(getRerankProvider().id).toBe("test");
		setRerankProvider(new NullRerankProvider());
		expect(getRerankProvider().id).toBe("null");
	});
});
