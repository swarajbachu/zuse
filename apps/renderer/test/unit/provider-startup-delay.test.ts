import { describe, expect, it } from "vitest";
import { providerStartupIsActive } from "../../src/components/chat-working-row.tsx";
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

	it("does not call an already-responsive provider startup on later turns", () => {
		expect(
			providerStartupIsActive({
				runtimeState: "starting",
				providerOutputStarted: true,
				startupContextActive: true,
			}),
		).toBe(false);
		expect(
			providerStartupIsActive({
				runtimeState: "starting",
				providerOutputStarted: false,
				startupContextActive: true,
			}),
		).toBe(true);
	});
});
