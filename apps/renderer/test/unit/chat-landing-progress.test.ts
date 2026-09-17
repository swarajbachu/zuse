import { ComposerInput, ExternalThread } from "@zuse/contracts";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";
import {
	filterImportThreads,
	isImportableThread,
	workspacePolicyForMode,
} from "../../src/components/chat-landing.tsx";
import chatLandingSource from "../../src/components/chat-landing.tsx?raw";
import { ChatStartupView } from "../../src/components/chat-startup-view.tsx";
import workspacePickerSource from "../../src/components/composer/workspace-picker.tsx?raw";
import {
	chatLandingProgress,
	cloudLaunchStepLabel,
} from "../../src/lib/chat-landing-progress.ts";
import cloudChatsSource from "../../src/lib/cloud-workspaces.ts?raw";
import externalThreadsSource from "../../src/store/external-threads.ts?raw";

describe("chat landing progress", () => {
	test("keeps provider thread imports out of the landing-page content", () => {
		expect(chatLandingSource).not.toContain("ContinueThreadsSection");
		expect(chatLandingSource).not.toContain("Continue Threads");
		expect(chatLandingSource).toContain("ImportChatMenu");
		expect(chatLandingSource).toContain(
			"chat:chat_landing_import_an_existing_chat",
		);
		expect(chatLandingSource).toContain(
			"chat:chat_landing_search_imported_chats",
		);
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
		expect(chatLandingSource).toMatch(
			/hydrateExternalThreads\(\s*importEnvironmentId,?\s*\)/,
		);
		expect(chatLandingSource).toMatch(
			/continueExternalThread\(\s*thread,\s*importEnvironmentId,?\s*\)/,
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
		expect(workspacePickerSource).toContain(
			"chat:workspace_picker_fresh_isolated_branch",
		);
		expect(workspacePickerSource).toContain(
			"chat:workspace_picker_use_the_main_checkout",
		);
		expect(workspacePickerSource).toContain("<MenuRadioGroup");
	});

	test("uses remembered project choices instead of worktree defaults", () => {
		expect(chatLandingSource).toContain("newChatPreferences.workspaceFor(");
		expect(chatLandingSource).toContain(
			"newChatPreferences.rememberEnvironment(",
		);
		expect(chatLandingSource).not.toContain("repositoryAutoCreateWorktree");
		expect(chatLandingSource).not.toContain("defaultAutoCreateWorktree");
	});

	test("stages the durable chat before attaching the workspace gateway", () => {
		expect(chatLandingSource).toContain("stageCloudChat(");
		expect(chatLandingSource).toContain('initialMessageDelivery: "mailbox-v1"');
		expect(chatLandingSource).toContain(
			'launch.initialMessageDelivery === "mailbox-v1"',
		);
		expect(chatLandingSource).toContain("await sendSessionMessage(");
		expect(cloudChatsSource).toContain("Compatibility only:");
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

	test("renders the submitted cloud message, one progress row, and the composer", () => {
		const html = renderToStaticMarkup(
			createElement(ChatStartupView, {
				input: ComposerInput.make({
					text: "Please read my image",
					attachments: [],
					fileRefs: [],
					skillRefs: [],
				}),
				previews: {},
				progress: createElement(
					"div",
					{ role: "status" },
					"Preparing workspace",
				),
				composer: createElement("textarea", { "aria-label": "Chat composer" }),
			}),
		);
		expect(html.match(/Please read my image/g)).toHaveLength(1);
		expect(html.match(/role="status"/g)).toHaveLength(1);
		expect(html.indexOf("Chat composer")).toBeGreaterThan(
			html.indexOf("Preparing workspace"),
		);
		expect(html).not.toContain("Type a message below to get started");
	});

	test("shows the sandbox's own boot phase while the workspace starts", () => {
		expect(chatLandingSource).toContain(
			'phase={pendingCloudSummary?.startupPhase ?? "allocating"}',
		);
		expect(cloudLaunchStepLabel("preparing")).toBe(
			"Copying files to the sandbox",
		);
		expect(cloudLaunchStepLabel("sending")).toBe("Sending message");
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
				cloudStep: "starting",
				hasPendingWorktree: true,
			}),
		).toEqual({ kind: "cloud", step: "starting" });
	});

	test("shows worktree progress for local workspace creation", () => {
		expect(
			chatLandingProgress({
				cloudStep: null,
				hasPendingWorktree: true,
			}),
		).toEqual({ kind: "worktree" });
	});

	test("shows no setup progress when neither operation is active", () => {
		expect(
			chatLandingProgress({
				cloudStep: null,
				hasPendingWorktree: false,
			}),
		).toEqual({ kind: "none" });
	});
});
