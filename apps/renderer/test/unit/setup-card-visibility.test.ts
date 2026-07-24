import { describe, expect, it } from "vitest";

import { shouldShowSetupCard } from "../../src/lib/setup-card-visibility.ts";

describe("shouldShowSetupCard", () => {
	it("does not show chat setup for an additional session in a ready worktree", () => {
		expect(
			shouldShowSetupCard({
				externalResume: false,
				hasWorktree: true,
				setupDone: true,
				providerBooting: true,
			}),
		).toBe(false);
	});

	it("shows setup while a new chat worktree is not ready", () => {
		expect(
			shouldShowSetupCard({
				externalResume: false,
				hasWorktree: true,
				setupDone: false,
				providerBooting: false,
			}),
		).toBe(true);
	});
});
