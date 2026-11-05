import { FolderId } from "@zuse/contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
	create: vi.fn(),
	select: vi.fn(),
	setTab: vi.fn(),
	environment: "local",
	tab: "automations",
	workspace: {},
	error: null as string | null,
}));
vi.mock("../../src/store/chats.ts", () => ({
	useChatsStore: {
		getState: () => ({
			create: state.create,
			select: state.select,
			error: state.error,
		}),
	},
}));
vi.mock("../../src/store/ui.ts", () => ({
	useUiStore: {
		getState: () => ({
			activeMainTab: state.tab,
			setActiveMainTab: state.setTab,
		}),
	},
}));
vi.mock("../../src/store/model-catalog.ts", () => ({
	currentModelCatalog: vi.fn(),
}));
vi.mock("../../src/lib/settings-client-bus.ts", () => ({
	useSettingsStore: {
		getState: () => ({
			defaultProviderId: "codex",
			defaultModelByProvider: { codex: "gpt-6" },
		}),
	},
}));
vi.mock("../../src/lib/rpc-client.ts", () => ({
	getActiveEnvironment: () => state.environment,
}));
vi.mock("../../src/lib/renderer-workspace.ts", () => ({
	rendererWorkspaceSnapshot: () => state.workspace,
}));

import {
	automationAgentPrompt,
	launchAutomationAgent,
} from "../../src/lib/automation-agent.ts";

beforeEach(() => {
	state.create.mockReset();
	state.select.mockReset();
	state.setTab.mockReset();
	state.environment = "local";
	state.tab = "automations";
	state.error = null;
	state.create.mockResolvedValue({ chatId: "chat-new" });
});
describe("automation agent creation", () => {
	it("starts a real session with the user's requested automation and navigates to it", async () => {
		await launchAutomationAgent(
			FolderId.make("repo"),
			"generate",
			"Daily Slack report",
		);
		expect(state.create).toHaveBeenCalledWith(
			"repo",
			"codex",
			"gpt-6",
			expect.objectContaining({
				preserveFocus: true,
				startupInput: expect.objectContaining({
					text: expect.stringContaining("Daily Slack report"),
					attachments: [],
				}),
			}),
		);
		const prompt = state.create.mock.calls[0]?.[3]?.startupInput?.text ?? "";
		expect(prompt).toContain("automation_catalog");
		expect(prompt).toContain("automation_save");
		expect(prompt).toContain("enabled:false");
		expect(state.select).toHaveBeenCalledWith("chat-new");
		expect(state.setTab).toHaveBeenCalledWith("chat");
	});
	it("does not steal focus when the user switches environments while creation is pending", async () => {
		state.create.mockImplementationOnce(async () => {
			state.environment = "other";
			return { chatId: "chat-new" };
		});
		await launchAutomationAgent(FolderId.make("repo"), "suggest", "");
		expect(state.select).not.toHaveBeenCalled();
	});
	it("surfaces session failures instead of reporting generated automations", async () => {
		state.create.mockResolvedValue(null);
		state.error = "Provider unavailable";
		await expect(
			launchAutomationAgent(FolderId.make("repo"), "generate", "Triage"),
		).rejects.toThrow("Provider unavailable");
		expect(state.select).not.toHaveBeenCalled();
	});
	it("retains optional focus areas in suggestion sessions", () => {
		expect(automationAgentPrompt("suggest", "Slow CI checks")).toContain(
			"Focus: Slow CI checks",
		);
	});
});
