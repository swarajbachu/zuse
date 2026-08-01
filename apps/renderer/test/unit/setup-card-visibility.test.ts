import { describe, expect, it } from "vitest";

import { shouldShowSetupCard } from "../../src/lib/setup-card-visibility.ts";

describe("shouldShowSetupCard", () => {
	it("does not show chat setup for an additional session in a ready worktree", () => {
		expect(
			shouldShowSetupCard({
				externalResume: false,
				initialSession: false,
				hasWorktree: true,
				setupDone: true,
			}),
		).toBe(false);
	});

	it("shows setup while a new chat worktree is not ready", () => {
		expect(
			shouldShowSetupCard({
				externalResume: false,
				initialSession: true,
				hasWorktree: true,
				setupDone: false,
			}),
		).toBe(true);
	});

	it("does not use the chat setup card for provider startup", () => {
		expect(
			shouldShowSetupCard({
				externalResume: false,
				initialSession: true,
				hasWorktree: false,
				setupDone: false,
			}),
		).toBe(false);
	});

	it("hides the card as soon as chat workspace setup finishes", () => {
		expect(
			shouldShowSetupCard({
				externalResume: false,
				initialSession: true,
				hasWorktree: true,
				setupDone: true,
			}),
		).toBe(false);
	});
});
