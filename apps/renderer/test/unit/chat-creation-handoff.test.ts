import {
	type ChatCreationOperation,
	ChatId,
	ComposerInput,
	FolderId,
	SessionId,
} from "@zuse/contracts";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
	resolveAgentStarting,
	resolvePendingStartupTranscriptPrompt,
	shouldRenderEmptyChatState,
	shouldRenderGenericAgentStartup,
} from "../../src/components/chat-view.tsx";
import { ChatCreationPromptBubble } from "../../src/components/pending-chat-creation.tsx";
import {
	CloudWorkspaceSetupView,
	SetupCardView,
} from "../../src/components/worktree-setup-card.tsx";
import worktreeSetupSource from "../../src/components/worktree-setup-card.tsx?raw";
import worktreeLifecycleSource from "../../src/hooks/use-worktree-setup-lifecycle.ts?raw";
import { selectChatSurface } from "../../src/lib/chat-surface-selection.ts";
import {
	chatStartupUsesQueue,
	chatStoreErrorMessage,
	restorePendingCreation,
	useChatsStore,
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
	it("renders the optimistic prompt with the canonical user bubble", () => {
		const html = renderToStaticMarkup(
			createElement(ChatCreationPromptBubble, { prompt: "Build it" }),
		);
		expect(html).toContain("data-chat-user-bubble");
		expect(html).toContain("bg-user-bubble");
		expect(html).not.toContain("bg-muted/70");
	});

	it("does not queue a ready plain-text startup turn", () => {
		const input = ComposerInput.make({
			text: "Start once",
			attachments: [],
			fileRefs: [],
			skillRefs: [],
			annotations: [],
		});

		expect(chatStartupUsesQueue(input, true)).toBe(false);
		expect(chatStartupUsesQueue(input, false)).toBe(true);
		expect(
			chatStartupUsesQueue(
				ComposerInput.make({
					...input,
					attachments: [
						{
							id: "pending-attachment",
							mimeType: "image/png",
							originalName: "startup.png",
						},
					],
				}),
				true,
			),
		).toBe(true);
	});

	it("keeps a ready plain startup prompt visible while workspace setup runs", () => {
		const restored = restorePendingCreation({
			...operation("running_setup"),
			startupInput: ComposerInput.make({
				text: "Keep this visible",
				attachments: [],
				fileRefs: [],
				skillRefs: [],
				annotations: [],
			}),
		});

		expect(resolvePendingStartupTranscriptPrompt(restored.creation, 0)).toBe(
			"Keep this visible",
		);
	});

	it("does not mirror queued startup input into the transcript", () => {
		const restored = restorePendingCreation({
			...operation("running_setup"),
			startupInput: ComposerInput.make({
				text: "Preparing an attachment",
				attachments: [
					{
						id: "pending-attachment",
						mimeType: "image/png",
						originalName: "startup.png",
					},
				],
				fileRefs: [],
				skillRefs: [],
				annotations: [],
			}),
		});

		expect(
			resolvePendingStartupTranscriptPrompt(restored.creation, 0),
		).toBeNull();
	});

	it("removes the startup preview when the canonical transcript arrives", () => {
		const restored = restorePendingCreation({
			...operation("starting_agent"),
			startupInput: ComposerInput.make({
				text: "Show this once",
				attachments: [],
				fileRefs: [],
				skillRefs: [],
				annotations: [],
			}),
		});

		expect(
			resolvePendingStartupTranscriptPrompt(restored.creation, 1),
		).toBeNull();
	});

	it("keeps the composer-bearing session surface mounted during creation", () => {
		expect(
			selectChatSurface({
				hasSession: true,
				hasPendingCreation: true,
			}),
		).toBe("session");
	});

	it("does not render the empty-chat prompt beneath an optimistic first message", () => {
		expect(
			shouldRenderEmptyChatState({
				messageCount: 0,
				hasPendingCreation: true,
				setupActive: false,
				agentStarting: false,
			}),
		).toBe(false);
	});

	it("rehydrates and follows the reserved worktree from the live chat shell", () => {
		expect(worktreeSetupSource).toContain("useWorktreeSetupLifecycle(");
		expect(worktreeLifecycleSource).toContain(
			"void refreshWorktrees(projectId)",
		);
		expect(worktreeLifecycleSource).toMatch(
			/\[creationPhase, projectId, refreshWorktrees, worktreeId\]/,
		);
		expect(worktreeLifecycleSource).toContain(
			"subscribeSetup(projectId, worktreeId)",
		);
	});

	it("rehydrates the authoritative phase without losing the submitted message", () => {
		const restored = restorePendingCreation(operation("running_setup"));
		expect(restored.creation.phase).toBe("running_setup");
		expect(restored.creation.prompt).toBe("Fix the lifecycle");
		expect(restored.session.status).toBe("booting");
	});

	it("clears stale optimistic creation state once provider output starts", () => {
		const restored = restorePendingCreation(operation("starting_agent"));
		useChatsStore.setState({
			creatingByProject: { [restored.creation.projectId]: true },
			pendingCreationByChat: {
				[restored.creation.chatId]: restored.creation,
			},
		});

		useChatsStore.getState().completeCreation(restored.creation.chatId);

		expect(
			useChatsStore.getState().pendingCreationByChat[restored.creation.chatId],
		).toBeUndefined();
		expect(
			useChatsStore.getState().creatingByProject[restored.creation.projectId],
		).toBe(false);
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
		expect(
			shouldRenderGenericAgentStartup({
				inFlight: false,
				agentStarting: true,
				hasPendingCreation: false,
			}),
		).toBe(true);
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
					onRerun: null,
				},
			}),
		);
		expect(html).toContain("<details");
		expect(html).not.toContain("<details open");
	});

	it("starts with concrete worktree progress instead of a generic preparation step", () => {
		const html = renderToStaticMarkup(
			createElement(SetupCardView, {
				data: {
					repoName: "zuse",
					hasWorktree: true,
					worktreePending: true,
					worktreeName: null,
					branch: null,
					baseBranch: null,
					setupStatus: null,
					setupOutput: "",
					onRerun: null,
				},
			}),
		);
		expect(html).toContain("<summary");
		expect(html).toContain("Creating a new copy of zuse");
		expect(html).not.toContain("Preparing workspace");
		expect(html).not.toContain("Starting agent");
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
