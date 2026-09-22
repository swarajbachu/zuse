import { type ChatId, EnvironmentId } from "@zuse/contracts";
import { beforeEach, describe, expect, it } from "vitest";

import {
	closeBottomTerminalTab,
	openNewBottomTerminal,
} from "../../src/lib/bottom-terminal-controller.ts";
import { terminalsKey, useTerminalsStore } from "../../src/store/terminals.ts";
import { bottomTerminalLayoutForChat, useUiStore } from "../../src/store/ui.ts";

const chatRef = {
	environmentId: EnvironmentId.make("computer-a"),
	chatId: "chat-a" as ChatId,
};

describe("bottom terminal lifecycle", () => {
	beforeEach(() => {
		useTerminalsStore.setState({ byKey: {}, ownerCatalogsByKey: {} });
		useUiStore.setState({ bottomTerminalLayoutByChat: {} });
	});

	it("keeps right and bottom terminals independent", () => {
		const terminals = useTerminalsStore.getState();
		const right = terminals.ensureSlot(chatRef, 0, "/workspace", "right");
		const bottom = terminals.ensureSlot(chatRef, 0, "/workspace", "bottom");

		expect(right.id).not.toBe(bottom.id);
		expect(terminalsKey(chatRef, "right")).not.toBe(
			terminalsKey(chatRef, "bottom"),
		);
		expect(
			useTerminalsStore.getState().byKey[terminalsKey(chatRef, "right")],
		).toEqual([right]);
		expect(
			useTerminalsStore.getState().byKey[terminalsKey(chatRef, "bottom")],
		).toEqual([bottom]);
	});

	it("hiding the bottom dock preserves its PTY while closing its tab removes it", () => {
		const terminal = useTerminalsStore
			.getState()
			.ensureSlot(chatRef, 0, "/workspace", "bottom");
		const ui = useUiStore.getState();

		ui.setBottomTerminalHeightForChat(chatRef, 320);
		ui.setActiveBottomTerminalForChat(chatRef, terminal.id);
		ui.setBottomTerminalOpenForChat(chatRef, true);
		ui.setBottomTerminalOpenForChat(chatRef, false);

		expect(bottomTerminalLayoutForChat(useUiStore.getState(), chatRef)).toEqual(
			{
				open: false,
				heightPx: 320,
				activeTerminalId: terminal.id,
			},
		);
		expect(
			useTerminalsStore.getState().byKey[terminalsKey(chatRef, "bottom")],
		).toEqual([terminal]);

		useTerminalsStore.getState().remove(chatRef, terminal.id, "bottom");

		expect(
			useTerminalsStore.getState().byKey[terminalsKey(chatRef, "bottom")],
		).toEqual([]);
	});

	it("selects a remaining tab and collapses only after the final tab closes", () => {
		const first = openNewBottomTerminal(chatRef, "/workspace");
		const second = openNewBottomTerminal(chatRef, "/workspace");
		if (first === null || second === null) {
			throw new Error("expected terminal slots below the owner limit");
		}

		expect(bottomTerminalLayoutForChat(useUiStore.getState(), chatRef)).toEqual(
			{
				open: true,
				heightPx: 260,
				activeTerminalId: second.id,
			},
		);

		closeBottomTerminalTab(chatRef, second.id);

		expect(bottomTerminalLayoutForChat(useUiStore.getState(), chatRef)).toEqual(
			{
				open: true,
				heightPx: 260,
				activeTerminalId: first.id,
			},
		);
		expect(
			useTerminalsStore.getState().byKey[terminalsKey(chatRef, "bottom")],
		).toEqual([first]);

		closeBottomTerminalTab(chatRef, first.id);

		expect(bottomTerminalLayoutForChat(useUiStore.getState(), chatRef)).toEqual(
			{
				open: false,
				heightPx: 260,
				activeTerminalId: null,
			},
		);
	});

	it("refuses a rapid extra allocation once the owner reaches its cap", () => {
		useTerminalsStore
			.getState()
			.reconcileOwned(chatRef, chatRef.environmentId, "bottom", {
				terminals: [],
				liveLimit: 4,
			});
		for (let index = 0; index < 4; index += 1) {
			expect(
				openNewBottomTerminal(chatRef, `/workspace/${index}`),
			).not.toBeNull();
		}

		expect(openNewBottomTerminal(chatRef, "/workspace/overflow")).toBeNull();
		expect(
			useTerminalsStore.getState().byKey[terminalsKey(chatRef, "bottom")],
		).toHaveLength(4);
	});
});
