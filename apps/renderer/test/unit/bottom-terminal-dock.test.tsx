import { type ChatId, EnvironmentId } from "@zuse/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it } from "vitest";

import { BottomTerminalDock } from "../../src/components/bottom-terminal-dock.tsx";
import { openNewBottomTerminal } from "../../src/lib/bottom-terminal-controller.ts";
import { useTerminalsStore } from "../../src/store/terminals.ts";
import { useUiStore } from "../../src/store/ui.ts";

const chatRef = {
	environmentId: EnvironmentId.make("computer-a"),
	chatId: "chat-a" as ChatId,
};

describe("BottomTerminalDock", () => {
	beforeEach(() => {
		useTerminalsStore.setState({ byKey: {}, ownerCatalogsByKey: {} });
		useUiStore.setState({ bottomTerminalLayoutByChat: {} });
	});

	it("offers a compact collapsed terminal without creating a PTY", () => {
		const markup = renderToStaticMarkup(
			<BottomTerminalDock chatRef={chatRef} rootPath="/workspace" />,
		);

		expect(markup).toContain('aria-label="Open bottom terminal"');
		expect(markup).toContain("Terminal");
		expect(useTerminalsStore.getState().byKey).toEqual({});
	});

	it("shows independent terminal tabs and explicit hide/close controls", () => {
		openNewBottomTerminal(chatRef, "/workspace");

		const markup = renderToStaticMarkup(
			<BottomTerminalDock chatRef={chatRef} rootPath="/workspace" />,
		);

		expect(markup).toContain('aria-label="Hide bottom terminal"');
		expect(markup).toContain('aria-label="New bottom terminal"');
		expect(markup).toContain('aria-label="Close zsh"');
	});

	it("explains and gates new terminals at the owner limit", () => {
		useTerminalsStore
			.getState()
			.reconcileOwned(chatRef, chatRef.environmentId, "bottom", {
				terminals: [],
				liveLimit: 4,
			});
		for (let index = 0; index < 4; index += 1) {
			openNewBottomTerminal(chatRef, `/workspace/${index}`);
		}

		const markup = renderToStaticMarkup(
			<BottomTerminalDock chatRef={chatRef} rootPath="/workspace" />,
		);

		expect(markup).toContain('aria-label="New bottom terminal"');
		expect(markup).toContain("disabled");
		expect(markup).toContain("Limit 4");
		expect(markup).toContain(
			"Terminal limit reached (4). Close a terminal, then retry.",
		);
	});
});
