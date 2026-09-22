import { type ChatId, EnvironmentId } from "@zuse/contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";

const catalog = vi.hoisted(() => ({
	loadTerminalCatalog: vi.fn(),
}));

vi.mock("../../src/lib/terminal-catalog.ts", () => ({
	loadTerminalCatalog: catalog.loadTerminalCatalog,
}));

import {
	openNewBottomTerminal,
	restoreOrOpenBottomTerminal,
} from "../../src/lib/bottom-terminal-controller.ts";
import { terminalsKey, useTerminalsStore } from "../../src/store/terminals.ts";
import { bottomTerminalLayoutForChat, useUiStore } from "../../src/store/ui.ts";

const chatRef = {
	environmentId: EnvironmentId.make("catalog-computer"),
	chatId: "catalog-chat" as ChatId,
};

describe("bottom terminal catalog gate", () => {
	beforeEach(() => {
		catalog.loadTerminalCatalog.mockReset();
		useTerminalsStore.setState({ byKey: {}, ownerCatalogsByKey: {} });
		useUiStore.setState({ bottomTerminalLayoutByChat: {} });
	});

	it("never allocates a PTY when the authoritative catalog lookup fails", async () => {
		catalog.loadTerminalCatalog.mockRejectedValue(new Error("connection lost"));

		await expect(
			restoreOrOpenBottomTerminal(chatRef, "/workspace"),
		).resolves.toBe("failed");

		expect(
			useTerminalsStore.getState().byKey[terminalsKey(chatRef, "bottom")],
		).toBeUndefined();
		expect(
			bottomTerminalLayoutForChat(useUiStore.getState(), chatRef).open,
		).toBe(true);
	});

	it("keeps an already known terminal without duplicating it on lookup failure", async () => {
		catalog.loadTerminalCatalog.mockRejectedValue(new Error("connection lost"));
		const existing = useTerminalsStore
			.getState()
			.ensureSlot(chatRef, 0, "/workspace", "bottom");

		await restoreOrOpenBottomTerminal(chatRef, "/workspace");

		expect(
			useTerminalsStore.getState().byKey[terminalsKey(chatRef, "bottom")],
		).toEqual([existing]);
	});

	it("allocates the first shell only after a successful catalog lookup", async () => {
		catalog.loadTerminalCatalog.mockResolvedValue(undefined);

		await expect(
			restoreOrOpenBottomTerminal(chatRef, "/workspace"),
		).resolves.toBe("ready");

		expect(
			useTerminalsStore.getState().byKey[terminalsKey(chatRef, "bottom")],
		).toHaveLength(1);
	});

	it("hydrates again before the plus action allocates another shell", async () => {
		openNewBottomTerminal(chatRef, "/workspace");
		let resolveCatalog: (() => void) | undefined;
		catalog.loadTerminalCatalog.mockReturnValue(
			new Promise<void>((resolve) => {
				resolveCatalog = resolve;
			}),
		);

		const result = restoreOrOpenBottomTerminal(chatRef, "/workspace", {
			createNew: true,
		});
		expect(
			useTerminalsStore.getState().byKey[terminalsKey(chatRef, "bottom")],
		).toHaveLength(1);

		resolveCatalog?.();
		await expect(result).resolves.toBe("ready");
		expect(
			useTerminalsStore.getState().byKey[terminalsKey(chatRef, "bottom")],
		).toHaveLength(2);
	});

	it("does not allocate from plus when its fresh catalog lookup fails", async () => {
		openNewBottomTerminal(chatRef, "/workspace");
		catalog.loadTerminalCatalog.mockRejectedValue(new Error("connection lost"));

		await expect(
			restoreOrOpenBottomTerminal(chatRef, "/workspace", { createNew: true }),
		).resolves.toBe("failed");
		expect(
			useTerminalsStore.getState().byKey[terminalsKey(chatRef, "bottom")],
		).toHaveLength(1);
	});

	it("rechecks the owner cap after plus hydration", async () => {
		for (let index = 0; index < 4; index += 1) {
			openNewBottomTerminal(chatRef, `/workspace/${index}`);
		}
		catalog.loadTerminalCatalog.mockImplementation(async () => {
			useTerminalsStore
				.getState()
				.reconcileOwned(chatRef, chatRef.environmentId, "bottom", {
					terminals: [],
					liveLimit: 4,
				});
		});

		await expect(
			restoreOrOpenBottomTerminal(chatRef, "/workspace/overflow", {
				createNew: true,
			}),
		).resolves.toBe("ready");
		expect(
			useTerminalsStore.getState().byKey[terminalsKey(chatRef, "bottom")],
		).toHaveLength(4);
	});

	it("does not open a stale chat when hydration settles after navigation", async () => {
		let resolveCatalog: (() => void) | undefined;
		catalog.loadTerminalCatalog.mockReturnValue(
			new Promise<void>((resolve) => {
				resolveCatalog = resolve;
			}),
		);
		let current = true;
		const resultPromise = restoreOrOpenBottomTerminal(chatRef, "/workspace", {
			isCurrent: () => current,
		});

		current = false;
		resolveCatalog?.();

		await expect(resultPromise).resolves.toBe("cancelled");
		expect(
			useTerminalsStore.getState().byKey[terminalsKey(chatRef, "bottom")],
		).toBeUndefined();
		expect(useUiStore.getState().bottomTerminalLayoutByChat).toEqual({});
	});
});
