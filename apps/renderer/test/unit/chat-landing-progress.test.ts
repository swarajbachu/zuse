import { describe, expect, test } from "vitest";
import chatLandingSource from "../../src/components/chat-landing.tsx?raw";
import { chatLandingProgress } from "../../src/lib/chat-landing-progress.ts";
import cloudChatsSource from "../../src/lib/cloud-workspaces.ts?raw";

describe("chat landing progress", () => {
	test("stages the durable chat before attaching the workspace gateway", () => {
		expect(chatLandingSource).toContain("stageCloudChat(");
		expect(chatLandingSource).toContain("ensureCloudWorkspaceAttached(");
		expect(chatLandingSource).not.toContain(
			'control["cloud.workspaces.connect"]',
		);
		expect(chatLandingSource).not.toContain("registerCloudWorkspace(");
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

	test("owns lifecycle polling behind the control-plane stream", () => {
		expect(cloudChatsSource).toContain('control["cloud.workspaces.watch"]');
		expect(cloudChatsSource).not.toContain("setTimeout");
		expect(cloudChatsSource).not.toContain("while (");
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
