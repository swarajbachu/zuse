import { type ChatId, EnvironmentId } from "@zuse/contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";

const controller = vi.hoisted(() => ({
	restoreOrAddRightTerminal: vi.fn(),
}));
const toast = vi.hoisted(() => ({ add: vi.fn() }));

vi.mock("../../src/lib/right-terminal-controller.ts", () => ({
	restoreOrAddRightTerminal: controller.restoreOrAddRightTerminal,
}));
vi.mock("../../src/components/ui/toast.tsx", () => ({
	toastManager: toast,
}));

import { openTerminalCommand } from "../../src/lib/run-terminal.ts";

const chatRef = {
	environmentId: EnvironmentId.make("run-environment"),
	chatId: "run-chat" as ChatId,
};
const command = {
	cmd: "/bin/zsh",
	args: ["-lc", "bun run dev"],
} as const;

describe("command terminal catalog gate", () => {
	beforeEach(() => {
		controller.restoreOrAddRightTerminal.mockReset();
		toast.add.mockReset();
	});

	it("requests a fresh command process through the shared controller", async () => {
		controller.restoreOrAddRightTerminal.mockResolvedValue({
			status: "ready",
			slot: 2,
			reused: false,
		});

		await expect(
			openTerminalCommand({
				chatRef,
				cwd: "/workspace",
				title: "Run",
				command,
			}),
		).resolves.toBe(true);
		expect(controller.restoreOrAddRightTerminal).toHaveBeenCalledWith({
			ref: chatRef,
			environmentId: chatRef.environmentId,
			cwd: "/workspace",
			title: "Run",
			command,
			reuseRestored: false,
		});
		expect(toast.add).not.toHaveBeenCalled();
	});

	it("surfaces an authoritative catalog or owner-limit failure", async () => {
		controller.restoreOrAddRightTerminal.mockResolvedValue({
			status: "failed",
			cause: new Error(
				"Terminal limit reached (4). Close a terminal, then retry.",
			),
		});

		await expect(
			openTerminalCommand({
				chatRef,
				cwd: "/workspace",
				title: "Run",
				command,
			}),
		).resolves.toBe(false);
		expect(toast.add).toHaveBeenCalledWith({
			type: "error",
			title: "Could not open Run terminal",
			description: "Terminal limit reached (4). Close a terminal, then retry.",
		});
	});
});
