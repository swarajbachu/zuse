import { describe, expect, it } from "vitest";
import { providerStartupLabel } from "../../src/lib/provider-startup-delay.ts";

describe("provider startup delay", () => {
	it("shows a non-terminal warning when startup takes longer than usual", () => {
		expect(
			providerStartupLabel({
				providerLabel: "Codex",
				failed: false,
				delayed: true,
			}),
		).toBe("Codex is taking longer than usual to start…");
	});

	it("keeps a real startup failure distinct from a delay", () => {
		expect(
			providerStartupLabel({
				providerLabel: "Codex",
				failed: true,
				delayed: true,
			}),
		).toBe("Codex failed to start");
	});
});
