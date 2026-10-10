import { EnvironmentId, FolderId } from "@zuse/contracts";
import { beforeEach, expect, test, vi } from "vitest";

const fixture = vi.hoisted(() => ({
	load: vi.fn(async () => {}),
	resolveMode: vi.fn(async () => "approval-required"),
	selectProvider: vi.fn((): "codex" | null => "codex"),
}));
vi.mock("../../src/store/providers.ts", () => ({
	useProvidersStore: {
		getState: () => ({ loadFor: fixture.load, availabilityByEnvironment: {} }),
	},
}));
vi.mock("../../src/lib/auto-worktree.ts", () => ({
	resolveChatRuntimeMode: fixture.resolveMode,
}));
vi.mock("../../src/lib/model-picker-availability.ts", () => ({
	selectAuthenticatedProvider: fixture.selectProvider,
}));
vi.mock("../../src/lib/settings-client-bus.ts", () => ({
	useSettingsStore: {
		getState: () => ({
			defaultProviderId: "codex",
			defaultModelByProvider: { codex: "gpt-5.4" },
			defaultRuntimeMode: "full-access",
		}),
	},
}));

import { prepareChatTab } from "../../src/lib/prepare-chat-tab.ts";

const environment = EnvironmentId.make("local");
const project = FolderId.make("project");
beforeEach(() => vi.resetAllMocks());

test("missing provider wins over a failed runtime-mode request", async () => {
	fixture.selectProvider.mockReturnValue(null);
	fixture.resolveMode.mockRejectedValue(new Error("Runtime unavailable"));
	await expect(prepareChatTab(environment, project)).resolves.toBeNull();
});

test("missing provider does not wait for runtime mode", async () => {
	fixture.selectProvider.mockReturnValue(null);
	let rejectMode: (reason: Error) => void = () => {};
	fixture.resolveMode.mockReturnValue(
		new Promise((_resolve, reject) => {
			rejectMode = reject;
		}),
	);
	await expect(prepareChatTab(environment, project)).resolves.toBeNull();
	rejectMode(new Error("Late runtime failure"));
	await new Promise((resolve) => setTimeout(resolve, 0));
});

test("authenticated provider still receives runtime-mode errors", async () => {
	const error = new Error("Runtime unavailable");
	fixture.resolveMode.mockRejectedValue(error);
	await expect(prepareChatTab(environment, project)).rejects.toBe(error);
});

test("provider discovery and runtime-mode resolution start concurrently", async () => {
	let release: () => void = () => {};
	fixture.load.mockReturnValue(
		new Promise((resolve) => {
			release = resolve;
		}),
	);
	const pending = prepareChatTab(environment, project);
	expect(fixture.resolveMode).toHaveBeenCalledWith(environment, project);
	expect(fixture.selectProvider).not.toHaveBeenCalled();
	release();
	await expect(pending).resolves.toEqual({
		providerId: "codex",
		model: "gpt-5.4",
		runtimeMode: "approval-required",
	});
});

test("no project uses the configured runtime mode", async () => {
	await expect(prepareChatTab(environment, null)).resolves.toEqual({
		providerId: "codex",
		model: "gpt-5.4",
		runtimeMode: "full-access",
	});
	expect(fixture.resolveMode).not.toHaveBeenCalled();
});
