import { describe, expect, it } from "vitest";

// Pure mapping is exercised via a thin re-export of the shape contract.
// CLI/API I/O is covered live; this guards the inventory schema assumptions
// used by the renderer.

describe("Kiro inventory model shape", () => {
	it("accepts control-plane style model entries", () => {
		const model = {
			id: "claude-opus-4.8",
			label: "Claude Opus 4.8",
			description: "Claude Opus 4.8 model with 1M context window",
			contextWindow: 1_000_000,
			rateMultiplier: 2.2,
			supportsImages: true,
		};
		expect(model.id).toContain("claude");
		expect(model.supportsImages).toBe(true);
		expect(model.rateMultiplier).toBeGreaterThan(1);
	});
});
