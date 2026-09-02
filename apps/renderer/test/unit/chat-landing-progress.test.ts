import { ExternalThread } from "@zuse/contracts";
import { describe, expect, test } from "vitest";
import {
	filterImportThreads,
	isImportableThread,
	workspacePolicyForMode,
} from "../../src/components/chat-landing.tsx";
import chatLandingSource from "../../src/components/chat-landing.tsx?raw";
import queueChipSource from "../../src/components/composer/queue-chip.tsx?raw";
import workspacePickerSource from "../../src/components/composer/workspace-picker.tsx?raw";
import { chatLandingProgress } from "../../src/lib/chat-landing-progress.ts";
import cloudChatsSource from "../../src/lib/cloud-workspaces.ts?raw";
import chatStoreSource from "../../src/store/chats.ts?raw";
import externalThreadsSource from "../../src/store/external-threads.ts?raw";

describe("chat landing progress", () => {
	test("dispatches the selected workspace mode without a settings preflight", () => {
		expect(chatLandingSource).toContain(
			"workspacePolicy: workspacePolicyForMode(workspaceMode)",
		);
		expect(chatStoreSource).not.toContain(
			"const workspacePolicy = await opts?.workspacePolicy",
		);
		expect(chatStoreSource).not.toContain("Promise<ChatWorkspace");
	});

	test("keeps provider thread imports out of the landing-page content", () => {
		expect(chatLandingSource).not.toContain("ContinueThreadsSection");
		expect(chatLandingSource).not.toContain("Continue Threads");
		expect(chatLandingSource).toContain("ImportChatMenu");
		expect(chatLandingSource).toContain('aria-label="Import an existing chat"');
		expect(chatLandingSource).toContain('aria-label="Search imported chats"');
		expect(chatLandingSource).toContain(
			"max-h-52 overflow-x-hidden overflow-y-auto",
		);
	});

	test("searches imported chats across conversation and provider metadata", () => {
		const threads = [
			ExternalThread.make({
				id: "thread-1",
				providerId: "codex",
				title: "Repair git lifecycle",
				preview: "Track pull request state",
				projectPath: "/work/zuse",
				projectName: "Zuse",
				updatedAt: new Date("2026-08-21T00:00:00Z"),
				sourcePath: null,
				cursor: "cursor-1",
				resumeStrategy: "codex-thread-id",
				available: true,
			}),
			ExternalThread.make({
				id: "thread-2",
				providerId: "claude",
				title: "Polish settings",
				preview: "Tighten the account page",
				projectPath: "/work/console",
				projectName: "Console",
				updatedAt: new Date("2026-08-20T00:00:00Z"),
				sourcePath: null,
				cursor: "cursor-2",
				resumeStrategy: "claude-session-id",
				available: true,
			}),
		];

		expect(filterImportThreads(threads, "pull request")).toEqual([threads[0]]);
		expect(filterImportThreads(threads, "claude code")).toEqual([threads[1]]);
		expect(filterImportThreads(threads, "console")).toEqual([threads[1]]);
	});

	test("hides missing and temporary provider threads from import", () => {
		const makeThread = (projectName: string, available: boolean) =>
			ExternalThread.make({
				id: `${projectName}-${available}`,
				providerId: "codex",
				title: "Imported chat",
				preview: "",
				projectPath: "/work/project",
				projectName,
				updatedAt: new Date("2026-08-21T00:00:00Z"),
				sourcePath: null,
				cursor: "cursor",
				resumeStrategy: "codex-thread-id",
				available,
			});

		expect(isImportableThread(makeThread("Zuse", true))).toBe(true);
		expect(isImportableThread(makeThread("Temporary folder", true))).toBe(
			false,
		);
		expect(isImportableThread(makeThread("T", true))).toBe(false);
		expect(isImportableThread(makeThread("Zuse", false))).toBe(false);
	});

	test("routes thread discovery through the computer selected in the composer", () => {
		expect(chatLandingSource).toContain(
			"hydrateExternalThreads(importEnvironmentId)",
		);
		expect(chatLandingSource).toMatch(
			/continueExternalThread\(\s*thread,\s*importEnvironmentId,\s*\)/,
		);
		expect(externalThreadsSource).not.toContain("getActiveEnvironment");
		expect(externalThreadsSource).toContain("environmentId: EnvironmentId");
	});

	test("lets each new chat explicitly choose a local checkout or worktree", () => {
		expect(workspacePolicyForMode("local")).toEqual({ _tag: "main" });
		expect(workspacePolicyForMode("worktree")).toEqual({ _tag: "fresh" });
		expect(chatLandingSource).toContain("<WorkspacePicker");
		expect(chatLandingSource).toContain(
			"workspacePolicyForMode(workspaceMode)",
		);
		expect(workspacePickerSource).toContain("Fresh isolated branch");
		expect(workspacePickerSource).toContain("Use the main checkout");
		expect(workspacePickerSource).toContain("<MenuRadioGroup");
	});

	test("initializes the active environment before selectors consume it", () => {
		const environmentSubscription = chatLandingSource.indexOf(
			"const activeEnvironmentId = useEnvironmentCatalogStore(",
		);
		const repositorySettingsSubscription = chatLandingSource.indexOf(
			"const repositoryAutoCreateWorktree = useRepositorySettingsStore(",
		);

		expect(environmentSubscription).toBeGreaterThan(-1);
		expect(repositorySettingsSubscription).toBeGreaterThan(
			environmentSubscription,
		);
	});

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

	test("keeps the submitted cloud message in the queued composer surface", () => {
		const message = chatLandingSource.indexOf("<QueuedComposerPreview");
		const cloudLifecycle = chatLandingSource.indexOf(
			'<CloudWorkspaceSetupView phase="allocating" />',
		);

		expect(message).toBeGreaterThan(-1);
		expect(message).toBeGreaterThan(cloudLifecycle);
		expect(chatLandingSource).toContain(
			'waitingForSandbox={progress.kind === "cloud"}',
		);
		expect(chatLandingSource).toContain("Waiting for sandbox");
		expect(chatLandingSource).not.toContain("Starting Cloud Sandbox");
		expect(queueChipSource).not.toContain("Saving message");
	});

	test("owns lifecycle polling behind the control-plane stream", () => {
		expect(cloudChatsSource).toContain('control["cloud.workspaces.watch"]');
		expect(cloudChatsSource).not.toContain("while (");
		// Deferred transcript pagination may schedule a task, but workspace
		// lifecycle progress itself must remain stream-driven rather than polling.
		expect(cloudChatsSource).toContain("completeOlderSessionMessages(ref)");
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
