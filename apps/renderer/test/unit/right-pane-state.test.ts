import { type ChatId, EnvironmentId, Folder, FolderId } from "@zuse/contracts";
import { beforeEach, describe, expect, it } from "vitest";

import {
	canUseChatPanel,
	logicalRightPaneProject,
} from "../../src/components/right-pane.tsx";
import {
	DEFAULT_RIGHT_PANE_WIDTH_PERCENT,
	rightPaneKey,
	useUiStore,
} from "../../src/store/ui.ts";

const chatA = {
	environmentId: EnvironmentId.make("computer-a"),
	chatId: "chat-a" as ChatId,
};
const chatB = {
	environmentId: EnvironmentId.make("computer-b"),
	chatId: "chat-b" as ChatId,
};
const keyA = rightPaneKey(chatA);
const keyB = rightPaneKey(chatB);

describe("chat-scoped right pane state", () => {
	it("keeps read-only panels available without offering host execution tools", () => {
		for (const kind of ["files", "plan"] as const) {
			expect(canUseChatPanel(kind, true)).toBe(true);
			expect(canUseChatPanel(kind, false)).toBe(true);
		}
		for (const kind of [
			"terminal",
			"changes",
			"pr",
			"browser",
			"subagents",
		] as const) {
			expect(canUseChatPanel(kind, true)).toBe(false);
			expect(canUseChatPanel(kind, false)).toBe(true);
		}
	});
	beforeEach(() => {
		useUiStore.setState({
			rightPaneLayoutByChat: {},
			rightPanelsByChat: {},
			activeRightPanelByChat: {},
			selectedSubagentByChat: {},
		});
	});

	it("keeps device viewers separate by environment and chat, and replaces the setup tab", () => {
		const ui = useUiStore.getState();
		ui.addPanel(chatA, "device");
		const starter = useUiStore.getState().rightPanelsByChat[keyA]?.[0];
		ui.openDevicePanel(chatA, "ABC", starter?.id);
		ui.openDevicePanel(chatA, "ABC");
		ui.openDevicePanel(chatA, "DEF");
		ui.openDevicePanel(chatB, "ABC");
		expect(useUiStore.getState().rightPanelsByChat[keyA]).toHaveLength(2);
		expect(useUiStore.getState().rightPanelsByChat[keyB]).toHaveLength(1);
		expect(useUiStore.getState().rightPanelsByChat[keyA]?.[0]).toMatchObject({
			id: starter?.id,
			kind: "device",
			deviceId: "ABC",
		});
		expect(useUiStore.getState().rightPaneLayoutByChat[keyA]?.open).toBe(true);
	});

	it("returns a simulator tab to its picker and folds duplicate pickers", () => {
		const ui = useUiStore.getState();
		ui.openDevicePanel(chatA, "ABC");
		const viewer = useUiStore.getState().rightPanelsByChat[keyA]?.[0];
		ui.showDevicePicker(chatA, viewer?.id ?? "");
		expect(useUiStore.getState().rightPanelsByChat[keyA]?.[0]).toEqual({
			id: viewer?.id,
			kind: "device",
		});
		ui.openDevicePanel(chatA, "DEF");
		ui.addPanel(chatA, "device");
		const picker = useUiStore.getState().rightPanelsByChat[keyA]?.at(-1);
		ui.openDevicePanel(chatA, "DEF", picker?.id);
		const panels = useUiStore.getState().rightPanelsByChat[keyA] ?? [];
		expect(
			panels.map((panel) => panel.kind === "device" && panel.deviceId),
		).toEqual([undefined, "DEF"]);
		expect(useUiStore.getState().activeRightPanelByChat[keyA]).toBe(
			panels[1]?.id,
		);
	});

	it("keeps visibility and width independent between chats", () => {
		const ui = useUiStore.getState();
		ui.setRightSidebarOpenForChat(chatA, true);
		ui.setRightSidebarWidthForChat(chatA, 31);
		ui.setRightSidebarOpenForChat(chatB, false);
		ui.setRightSidebarWidthForChat(chatB, 44);

		expect(useUiStore.getState().rightPaneLayoutByChat).toMatchObject({
			[keyA]: { open: true, widthPercent: 31 },
			[keyB]: { open: false, widthPercent: 44 },
		});
	});

	it("reveals a panel in a background chat without touching the selected chat", () => {
		useUiStore.getState().revealPanelForChat(chatB, "browser");

		const state = useUiStore.getState();
		expect(state.rightPaneLayoutByChat[keyA]).toBeUndefined();
		expect(state.rightPaneLayoutByChat[keyB]).toEqual({
			open: true,
			widthPercent: DEFAULT_RIGHT_PANE_WIDTH_PERCENT,
		});
		expect(state.rightPanelsByChat[keyA]).toBeUndefined();
		expect(state.rightPanelsByChat[keyB]?.map((panel) => panel.kind)).toEqual([
			"browser",
		]);
		expect(state.activeRightPanelByChat[keyB]).toBe(
			state.rightPanelsByChat[keyB]?.[0]?.id,
		);
	});

	it("clears every right-pane record when a chat is removed", () => {
		const ui = useUiStore.getState();
		ui.revealPanelForChat(chatB, "browser");
		ui.setRightSidebarWidthForChat(chatB, 37);
		ui.selectSubagent(chatB, "session-child");

		ui.clearChatPanels(chatB);

		const state = useUiStore.getState();
		expect(state.rightPaneLayoutByChat[keyB]).toBeUndefined();
		expect(state.rightPanelsByChat[keyB]).toBeUndefined();
		expect(state.activeRightPanelByChat[keyB]).toBeUndefined();
		expect(state.selectedSubagentByChat[keyB]).toBeUndefined();
	});

	it("isolates equal chat ids across environments", () => {
		const chatId = "same-chat" as ChatId;
		const first = { environmentId: EnvironmentId.make("a"), chatId };
		const second = { environmentId: EnvironmentId.make("b"), chatId };
		const ui = useUiStore.getState();
		ui.revealPanelForChat(first, "files");
		ui.revealPanelForChat(second, "browser");

		expect(
			useUiStore.getState().rightPanelsByChat[rightPaneKey(first)]?.[0]?.kind,
		).toBe("files");
		expect(
			useUiStore.getState().rightPanelsByChat[rightPaneKey(second)]?.[0]?.kind,
		).toBe("browser");
	});

	it("keeps the logical project selected when cloud execution uses a sandbox folder", () => {
		const localProjectId = FolderId.make("folder-local");
		const sandboxFolderId = FolderId.make("folder-sandbox");
		const project = Folder.make({
			id: localProjectId,
			name: "repository",
			path: "/Users/example/repository",
			addedAt: new Date(0),
		});

		expect(sandboxFolderId).not.toBe(localProjectId);
		expect(logicalRightPaneProject([project], localProjectId)).toBe(project);
	});
	it("uses the connected cloud project when no local project is selected", () => {
		const cloud = Folder.make({
			id: FolderId.make("sandbox"),
			name: "zuse",
			path: "/home/repos/zuse",
			addedAt: new Date(0),
		});
		expect(logicalRightPaneProject([], null, cloud)).toBe(cloud);
	});
});

describe("projectless chat panels", () => {
	it("hides PR and Changes while retaining them for repository threads", () => {
		for (const kind of ["pr", "changes"] as const) {
			expect(canUseChatPanel(kind, false, true)).toBe(false);
			expect(canUseChatPanel(kind, false, false)).toBe(true);
		}
	});
	it("keeps files, terminals, and other independent panels available", () => {
		for (const kind of [
			"files",
			"terminal",
			"browser",
			"plan",
			"subagents",
		] as const) {
			expect(canUseChatPanel(kind, false, true)).toBe(true);
		}
	});
});
