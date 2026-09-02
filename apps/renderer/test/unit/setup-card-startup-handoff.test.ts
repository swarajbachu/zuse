import { describe, expect, it } from "vitest";
import setupCardSource from "../../src/components/worktree-setup-card.tsx?raw";
import {
	type SetupCardVisibilityInput,
	shouldShowSetupCard,
	workspaceCreationProgressIsActive,
} from "../../src/lib/setup-card-visibility.ts";

describe("setup card startup handoff", () => {
	it("ends the setup row when a completed creation hands off to agent activity", () => {
		expect(
			shouldShowSetupCard({
				externalResume: false,
				initialSession: true,
				hasWorktree: true,
				setupDone: true,
			}),
		).toBe(false);
	});

	it("ends workspace progress as soon as setup finishes", () => {
		const completedWorkspace: SetupCardVisibilityInput & {
			readonly creationPending: boolean;
		} = {
			externalResume: false,
			initialSession: true,
			hasWorktree: true,
			setupDone: true,
			// A stale chat-creation projection must not keep completed workspace
			// progress mounted through provider startup.
			creationPending: true,
		};
		expect(shouldShowSetupCard(completedWorkspace)).toBe(false);
	});

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
});
