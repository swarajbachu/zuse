import {
	type ChatCreationOperation,
	ChatId,
	FolderId,
	SessionId,
} from "@zuse/contracts";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
	resolveAgentStarting,
	shouldRenderGenericAgentStartup,
} from "../../src/components/chat-view.tsx";
import {
	CloudWorkspaceSetupView,
	SetupCardView,
} from "../../src/components/worktree-setup-card.tsx";
import { selectChatSurface } from "../../src/lib/chat-surface-selection.ts";
import {
	chatStoreErrorMessage,
	restorePendingCreation,
} from "../../src/store/chats.ts";

const operation = (
	phase: ChatCreationOperation["phase"],
): ChatCreationOperation => ({
	operationId: "create-1",
	chatId: ChatId.make("chat-1"),
	initialSessionId: SessionId.make("session-1"),
	projectId: FolderId.make("project-1"),
	providerId: "codex",
	model: "gpt-5.4",
	title: null,
	runtimeMode: "approval-required",
	permissionMode: "default",
	toolSearch: false,
	prompt: "Fix the lifecycle",
	startupInput: null,
	startupQueueId: null,
	startupReady: true,
	workspacePolicy: { _tag: "fresh" },
	worktreeId: null,
	phase,
	failureStage: null,
	retryable: true,
	attempts: { workspace: 0, setup: 0, provider: 0 },
	setupBypassed: false,
	leaseEpoch: 0,
	fingerprintVersion: 1,
	phaseStartedAt: new Date("2026-08-20T00:00:00Z"),
	error: null,
	createdAt: new Date("2026-08-20T00:00:00Z"),
	updatedAt: new Date("2026-08-20T00:00:01Z"),
});

describe("chat creation handoff", () => {
	it("keeps the composer-bearing session surface mounted during creation", () => {
		expect(
			selectChatSurface({
				hasSession: true,
				hasPendingCreation: true,
			}),
		).toBe("session");
	});

	it("rehydrates the authoritative phase without losing the submitted message", () => {
		const restored = restorePendingCreation(operation("running_setup"));
		expect(restored.creation.phase).toBe("running_setup");
		expect(restored.creation.prompt).toBe("Fix the lifecycle");
		expect(restored.session.status).toBe("booting");
	});

	it("keeps setup failures recoverable in place", () => {
		const failed: ChatCreationOperation = {
			...operation("failed"),
			failureStage: "setup",
			error: "setup failed",
			attempts: { workspace: 1, setup: 2, provider: 0 },
		};
		const restored = restorePendingCreation(failed);
		expect(restored.creation.failureStage).toBe("setup");
		expect(restored.creation.attempts.setup).toBe(2);
		expect(restored.session.status).toBe("error");
	});

	it("does not announce agent startup while the durable lifecycle is still setting up", () => {
		expect(
			resolveAgentStarting({
				providerOutputStarted: false,
				creationPhase: "running_setup",
				sessionBooting: true,
				inFlight: true,
				queuedItems: 1,
			}),
		).toBe(false);
		expect(
			resolveAgentStarting({
				providerOutputStarted: false,
				creationPhase: "starting_agent",
				sessionBooting: true,
				inFlight: true,
				queuedItems: 1,
			}),
		).toBe(true);
		expect(
			shouldRenderGenericAgentStartup({
				inFlight: true,
				hasPendingCreation: true,
			}),
		).toBe(false);
	});

	it("does not turn an intentional stream replacement into a chat error", () => {
		expect(
			chatStoreErrorMessage(new Error("All fibers interrupted without error")),
		).toBeNull();
	});

	it("keeps verbose setup output collapsed by default", () => {
		const html = renderToStaticMarkup(
			createElement(SetupCardView, {
				data: {
					repoName: "zuse",
					hasWorktree: true,
					worktreePending: false,
					worktreeName: "bayleef",
					branch: "feature/bayleef",
					baseBranch: "main",
					setupStatus: "running",
					setupOutput: "installing dependencies",
					agentStarting: undefined,
					onRerun: null,
				},
			}),
		);
		expect(html).toContain("<details");
		expect(html).not.toContain("<details open");
	});

	it("renders startup as one compact accordion with one agent indicator", () => {
		const html = renderToStaticMarkup(
			createElement(SetupCardView, {
				data: {
					repoName: "zuse",
					hasWorktree: true,
					worktreePending: false,
					worktreeName: "bayleef",
					branch: "feature/bayleef",
					baseBranch: "main",
					setupStatus: "succeeded",
					setupOutput: "",
					agentStarting: true,
					onRerun: null,
				},
			}),
		);
		expect(html).toContain("<summary");
		expect(html.match(/Starting agent/g)).toHaveLength(1);
		expect(html).not.toContain("rounded-xl");
	});

	it("uses the compact lifecycle accordion for cloud creation", () => {
		const preparing = renderToStaticMarkup(
			createElement(CloudWorkspaceSetupView, { phase: "syncing-repository" }),
		);
		const startingAgent = renderToStaticMarkup(
			createElement(CloudWorkspaceSetupView, { phase: "starting-agent" }),
		);

		expect(preparing).toContain("<details");
		expect(preparing).not.toContain("<details open");
		expect(preparing).toContain("Preparing repository…");
		expect(preparing).not.toContain("Fetching the latest Git changes");
		expect(startingAgent).toContain("Cloud workspace ready");
		expect(startingAgent).not.toContain("Starting agent");
	});
});
