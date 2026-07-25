import type { ChatId } from "@zuse/contracts";
import { beforeEach, describe, expect, it } from "vitest";

import { useChatsStore } from "../../src/store/chats.ts";
import {
	DEFAULT_RIGHT_PANE_WIDTH_PERCENT,
	useUiStore,
} from "../../src/store/ui.ts";

const chatA = "chat-a" as ChatId;
const chatB = "chat-b" as ChatId;

describe("chat-scoped right pane state", () => {
	beforeEach(() => {
		useChatsStore.setState({ selectedChatId: chatA });
		useUiStore.setState({
			rightPaneLayoutByChat: {},
			rightPanelsByChat: {},
			activeRightPanelByChat: {},
			selectedSubagentByChat: {},
		});
	});

	it("keeps visibility and width independent between chats", () => {
		const ui = useUiStore.getState();
		ui.setRightSidebarOpen(true);
		ui.setRightSidebarWidthForChat(chatA, 31);
		ui.setRightSidebarOpenForChat(chatB, false);
		ui.setRightSidebarWidthForChat(chatB, 44);

		expect(useUiStore.getState().rightPaneLayoutByChat).toMatchObject({
			[chatA]: { open: true, widthPercent: 31 },
			[chatB]: { open: false, widthPercent: 44 },
		});
	});

	it("reveals a panel in a background chat without touching the selected chat", () => {
		useUiStore.getState().revealPanelForChat(chatB, "browser");

		const state = useUiStore.getState();
		expect(state.rightPaneLayoutByChat[chatA]).toBeUndefined();
		expect(state.rightPaneLayoutByChat[chatB]).toEqual({
			open: true,
			widthPercent: DEFAULT_RIGHT_PANE_WIDTH_PERCENT,
		});
		expect(state.rightPanelsByChat[chatA]).toBeUndefined();
		expect(state.rightPanelsByChat[chatB]?.map((panel) => panel.kind)).toEqual([
			"browser",
		]);
		expect(state.activeRightPanelByChat[chatB]).toBe(
			state.rightPanelsByChat[chatB]?.[0]?.id,
		);
	});

	it("clears every right-pane record when a chat is removed", () => {
		const ui = useUiStore.getState();
		ui.revealPanelForChat(chatB, "browser");
		ui.setRightSidebarWidthForChat(chatB, 37);
		ui.selectSubagent("session-child");

		ui.clearChatPanels(chatB);

		const state = useUiStore.getState();
		expect(state.rightPaneLayoutByChat[chatB]).toBeUndefined();
		expect(state.rightPanelsByChat[chatB]).toBeUndefined();
		expect(state.activeRightPanelByChat[chatB]).toBeUndefined();
		expect(state.selectedSubagentByChat[chatB]).toBeUndefined();
	});
});
