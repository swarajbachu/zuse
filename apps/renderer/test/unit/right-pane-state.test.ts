import { type ChatId, EnvironmentId, Folder, FolderId } from "@zuse/contracts";
import { beforeEach, describe, expect, it } from "vitest";

import { logicalRightPaneProject } from "../../src/components/right-pane.tsx";
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
	beforeEach(() => {
		useUiStore.setState({
			rightPaneLayoutByChat: {},
			rightPanelsByChat: {},
			activeRightPanelByChat: {},
			selectedSubagentByChat: {},
		});
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
});
