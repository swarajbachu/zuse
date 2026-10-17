import { describe, expect, it } from "vitest";
import setupCardSource from "../../src/components/worktree-setup-card.tsx?raw";
import { workspaceCreationProgressIsActive } from "../../src/lib/setup-card-visibility.ts";

describe("setup card startup handoff", () => {
	it("does not use chat creation or agent activity to keep workspace progress mounted", () => {
		expect(setupCardSource).not.toContain(
			"creationPending: pendingCreation !== null",
		);
		expect(setupCardSource).not.toContain("agentStarting !== undefined");
		expect(setupCardSource).not.toContain("Starting agent…");
	});

	it("hands stale creation state off once the worktree itself is ready", () => {
		expect(
			workspaceCreationProgressIsActive({
				workspaceRequested: true,
				setupStatus: "skipped",
				creationPhase: "persisted",
			}),
		).toBe(false);
		expect(
			workspaceCreationProgressIsActive({
				workspaceRequested: true,
				setupStatus: null,
				creationPhase: "starting_agent",
			}),
		).toBe(false);
	});

	it("does not leave an interrupted or cancelled setup looking active", () => {
		for (const creationPhase of ["failed", "cancelled"] as const) {
			expect(
				workspaceCreationProgressIsActive({
					workspaceRequested: true,
					setupStatus: "running",
					creationPhase,
				}),
			).toBe(false);
		}
	});
});
