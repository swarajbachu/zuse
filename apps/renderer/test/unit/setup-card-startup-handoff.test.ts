import { describe, expect, it } from "vitest";
import setupCardSource from "../../src/components/worktree-setup-card.tsx?raw";
import { shouldShowSetupCard } from "../../src/lib/setup-card-visibility.ts";

describe("setup card startup handoff", () => {
	it("ends the setup row when a completed creation hands off to agent activity", () => {
		expect(
			shouldShowSetupCard({
				externalResume: false,
				initialSession: true,
				hasWorktree: true,
				setupDone: true,
				creationPending: false,
			}),
		).toBe(false);
	});

	it("keeps the setup row until the durable creation lifecycle finishes", () => {
		expect(
			shouldShowSetupCard({
				externalResume: false,
				initialSession: true,
				hasWorktree: true,
				setupDone: true,
				creationPending: true,
			}),
		).toBe(true);
	});

	it("does not use transient agent activity to keep the setup row mounted", () => {
		expect(setupCardSource).toContain(
			"creationPending: pendingCreation !== null",
		);
		expect(setupCardSource).not.toContain("agentStarting !== undefined");
	});
});
