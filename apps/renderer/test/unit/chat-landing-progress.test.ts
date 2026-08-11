import { describe, expect, test } from "vitest";
import chatLandingSource from "../../src/components/chat-landing.tsx?raw";
import { chatLandingProgress } from "../../src/lib/chat-landing-progress.ts";

describe("chat landing progress", () => {
	test("launches cloud chats through the workspace gateway without catalog polling", () => {
		expect(chatLandingSource).toContain('control["cloud.workspaces.connect"]');
		expect(chatLandingSource).toContain("registerCloudWorkspace(");
		expect(chatLandingSource).toContain("switchToCloudWorkspace(");
		expect(chatLandingSource).not.toContain(
			'control["cloud.workspaces.connected"]',
		);
		expect(chatLandingSource).not.toContain(
			'control["cloud.workspaces.chatCreated"]',
		);
		expect(chatLandingSource).not.toContain(
			'control["cloud.workspaces.agentStarted"]',
		);
	});

	test("shows only cloud progress while a cloud workspace is starting", () => {
		expect(
			chatLandingProgress({
				cloudStatus: "Allocating cloud sandbox…",
				hasPendingWorktree: true,
			}),
		).toEqual({ kind: "cloud", status: "Allocating cloud sandbox…" });
	});

	test("shows worktree progress for local workspace creation", () => {
		expect(
			chatLandingProgress({
				cloudStatus: null,
				hasPendingWorktree: true,
			}),
		).toEqual({ kind: "worktree" });
	});

	test("shows no setup progress when neither operation is active", () => {
		expect(
			chatLandingProgress({
				cloudStatus: null,
				hasPendingWorktree: false,
			}),
		).toEqual({ kind: "none" });
	});
});
