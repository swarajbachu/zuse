import { describe, expect, it } from "vitest";
import { StreamingTextReveal } from "../../src/lib/streaming-text-reveal.ts";

describe("streaming text presentation", () => {
	it("paints history immediately and spreads only appended text over frames", () => {
		const reveal = new StreamingTextReveal("history");
		expect(reveal.text).toBe("history");
		reveal.update("historyabcdefghij", 0, true);
		expect(reveal.frame(60)).toBe("historyabcde");
		expect(reveal.frame(120)).toBe("historyabcdefghij");
		expect(reveal.pending).toBe(false);
	});
	it("does not extend the pending deadline when another chunk arrives", () => {
		const reveal = new StreamingTextReveal("");
		reveal.update("abcdef", 0, true);
		expect(reveal.frame(60)).toBe("abc");
		reveal.update("abcdefghijkl", 60, true);
		expect(reveal.frame(120)).toBe("abcdefghijkl");
	});
	it("flushes immediately on completion, reduced motion, replacement and large loads", () => {
		const reveal = new StreamingTextReveal("a");
		reveal.update("abcdef", 0, true);
		reveal.update("abcdef", 10, false);
		expect(reveal.text).toBe("abcdef");
		reveal.update("replacement", 20, true);
		expect(reveal.text).toBe("replacement");
		reveal.update(`replacement${"a".repeat(5000)}`, 30, true);
		expect(reveal.pending).toBe(false);
	});
	it("does not split emoji or lose the final character", () => {
		const reveal = new StreamingTextReveal("");
		reveal.update("😀😀", 0, true);
		expect(reveal.frame(30)).toBe("");
		expect(reveal.frame(60)).toBe("😀");
		expect(reveal.frame(120)).toBe("😀😀");
	});
});
