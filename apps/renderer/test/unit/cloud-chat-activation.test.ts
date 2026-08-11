import {
	AgentSessionId,
	ChatId,
	CloudChatSummary,
	FolderId,
} from "@zuse/contracts";
import { afterEach, describe, expect, test } from "vitest";
import chatLandingSource from "../../src/components/chat-landing.tsx?raw";
import projectsSidebarSource from "../../src/components/projects-sidebar.tsx?raw";
import terminalPaneSource from "../../src/components/terminal-pane.tsx?raw";
import commandsSource from "../../src/lib/commands.ts?raw";
import { registerCloudChat } from "../../src/store/cloud-chat-registry.ts";
import cloudChatsSource from "../../src/store/cloud-chats.ts?raw";
import messagesSource from "../../src/store/messages.ts?raw";
import { useTerminalsStore } from "../../src/store/terminals.ts";

const initialTerminalsState = useTerminalsStore.getInitialState();

afterEach(() => useTerminalsStore.setState(initialTerminalsState, true));

describe("cloud chat activation", () => {
	test("viewing history does not activate a paused workspace", () => {
		expect(projectsSidebarSource).toContain(
			"openCloudChat(summary, projectId)",
		);
		expect(cloudChatsSource).toContain(
			"if (!activate && !alreadyLive) return;",
		);
	});

	test("an explicit message activates and attaches the workspace", () => {
		expect(chatLandingSource).toContain("{ activate: true }");
		expect(messagesSource).toContain(
			"openCloudChat(cloudSummary, projectId, { activate: true })",
		);
	});

	test("central history releases the ordinary composer without a runtime", () => {
		expect(cloudChatsSource).toContain(
			"markQueueHydrated(SessionId.make(summary.initialSessionId))",
		);
		expect(cloudChatsSource).toContain(
			'summary.state === "failed" ? "error" : "idle"',
		);
		expect(cloudChatsSource).toContain(
			"const liveSeed = seedFor(current, folder.id, history.firstMessage)",
		);
	});

	test("opens cached history immediately without replacing status with Opening", () => {
		expect(cloudChatsSource).toContain(
			"readCachedHistory(summary.workspaceId)",
		);
		expect(projectsSidebarSource).not.toContain('opening ? "Opening…"');
		expect(projectsSidebarSource).toContain("historyLoadingByChat");
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
			runtimeState: "offline",
			statusCode: "paused",
			startupPhase: "running",
			unread: false,
			createdAt: 1,
			updatedAt: 1,
		});
		registerCloudChat(summary, FolderId.make("folder-local"));
		const terminal = useTerminalsStore
			.getState()
			.ensureSlot(summary.chatId, 0, "/Users/local/repository");
		expect(terminal.environmentId).toBe(summary.workspaceId);
		expect(terminal.cwd).toBe("/home/zuse/workspace");
		expect(terminalPaneSource).toContain("Resuming cloud workspace…");
	});
});
