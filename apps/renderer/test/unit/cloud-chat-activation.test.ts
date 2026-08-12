import {
	AgentSessionId,
	ChatId,
	CloudChatHistory,
	CloudChatSummary,
	FolderId,
} from "@zuse/contracts";
import { afterEach, describe, expect, test } from "vitest";
import chatLandingSource from "../../src/components/chat-landing.tsx?raw";
import projectsSidebarSource from "../../src/components/projects-sidebar.tsx?raw";
import terminalPaneSource from "../../src/components/terminal-pane.tsx?raw";
import commandsSource from "../../src/lib/commands.ts?raw";
import chatsSource from "../../src/store/chats.ts?raw";
import { registerCloudChat } from "../../src/store/cloud-chat-registry.ts";
import { messagesFromHistory } from "../../src/store/cloud-chats.ts";
import cloudChatsSource from "../../src/store/cloud-chats.ts?raw";
import messagesSource from "../../src/store/messages.ts?raw";
import sessionsSource from "../../src/store/sessions.ts?raw";
import { useTerminalsStore } from "../../src/store/terminals.ts";

const initialTerminalsState = useTerminalsStore.getInitialState();

afterEach(() => useTerminalsStore.setState(initialTerminalsState, true));

describe("cloud chat activation", () => {
	test("viewing history does not activate a paused workspace", () => {
		expect(projectsSidebarSource).toContain(
			"openCloudChat(summary, projectId)",
		);
		expect(cloudChatsSource).toContain(
			"export const ensureCloudWorkspaceAttached",
		);
		expect(terminalPaneSource).not.toContain(
			"openCloudChat(cloudSummary, cloudProjectId, { activate: true })",
		);
		expect(terminalPaneSource).toContain("onKeyDown={(event) =>");
		expect(terminalPaneSource).toContain("connectCloudTerminal()");
		expect(chatsSource).toContain(
			"if (cloudSummaryForChat(chatId) !== null) return;",
		);
	});

	test("an explicit message activates and attaches the workspace", () => {
		expect(chatLandingSource).toContain(
			"ensureCloudWorkspaceAttached(summary)",
		);
		expect(messagesSource).toContain(
			"ensureCloudWorkspaceAttached(cloudSummary)",
		);
		expect(cloudChatsSource).toContain("cloudWorkspaceNeedsResume(discovered)");
		expect(cloudChatsSource).toContain(
			"current = refreshSummaryFromWorkspace(current, resumed)",
		);
	});

	test("new tabs in a cloud chat create their session in the cloud workspace", () => {
		expect(sessionsSource).toContain(
			"ensureCloudWorkspaceAttached(cloudSummary)",
		);
		expect(sessionsSource).toContain("cloudSummary?.workspaceId");
	});

	test("central history releases the ordinary composer without a runtime", () => {
		expect(cloudChatsSource).toContain(
			"markQueueHydrated(SessionId.make(summary.initialSessionId))",
		);
		expect(cloudChatsSource).toContain(
			'summary.state === "failed" ? "error" : "idle"',
		);
		expect(cloudChatsSource).toContain("mergeCloudChatMessages(");
	});

	test("projects the durable first message before runtime events exist", () => {
		const history = CloudChatHistory.make({
			workspaceId: "workspace-starting",
			chatId: ChatId.make("chat-starting"),
			initialSessionId: AgentSessionId.make("session-starting"),
			firstMessage: "Please inspect the repository",
			commandState: "queued",
			events: [],
			queuedMessages: [],
			cursor: 0,
		});

		expect(messagesFromHistory(history)).toMatchObject([
			{
				role: "user",
				content: { _tag: "user", text: "Please inspect the repository" },
			},
		]);
	});

	test("opens cached history immediately without replacing status with Opening", () => {
		expect(cloudChatsSource).toContain("cloudChatSnapshotStore");
		expect(cloudChatsSource).toContain(".load(summary.workspaceId)");
		expect(projectsSidebarSource).not.toContain('opening ? "Opening…"');
		expect(projectsSidebarSource).toContain("historyLoadingByChat");
	});

	test("shows cloud startup progress in the sidebar row", () => {
		expect(projectsSidebarSource).toContain("cloudWorkspaceLoading");
		expect(projectsSidebarSource).toContain(
			"cloudWorkspaceLoading || historyLoading",
		);
	});

	test("archives cloud chats through the control plane", () => {
		expect(cloudChatsSource).toContain('client["cloud.workspaces.archive"]');
		expect(projectsSidebarSource).toContain("archive(summary)");
	});

	test("one new-chat action switches back and opens the landing", () => {
		expect(commandsSource).toContain("localProjectForCloudChat");
		expect(commandsSource).toContain(
			"openNewChatLanding(result.selectedFolderId)",
		);
	});

	test("pins cloud terminals to the sandbox checkout", () => {
		const summary = CloudChatSummary.make({
			workspaceId: "workspace-cloud",
			projectId: "project-cloud",
			repositoryIdentity: "github.com/example/repository",
			repositoryDisplayName: "repository",
			chatId: ChatId.make("chat-cloud"),
			initialSessionId: AgentSessionId.make("session-cloud"),
			title: "Cloud chat",
			branch: "zuse/cloud",
			providerId: "provider-cloud",
			agent: "codex",
			model: "gpt-5.6",
			state: "paused",
			desiredState: "paused",
			runtimeState: "offline",
			statusCode: "paused",
			startupPhase: "running",
			revision: 1,
			unread: false,
			lastMessageAt: 1,
			createdAt: 1,
			updatedAt: 1,
		});
		registerCloudChat(summary, FolderId.make("folder-local"));
		const terminal = useTerminalsStore
			.getState()
			.ensureSlot(summary.chatId, 0, "/Users/local/repository");
		expect(terminal.environmentId).toBe(summary.workspaceId);
		expect(terminal.cwd).toBe("/home/zuse/workspace");
		expect(terminalPaneSource).toContain(
			"Workspace paused — type here to resume the terminal.",
		);
		expect(terminalPaneSource).toContain("initialInput={pendingTerminalInput}");
	});
});
