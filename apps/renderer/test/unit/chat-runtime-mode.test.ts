import {
	EnvironmentId,
	FolderId,
	type RepositorySettings,
	SettingsFile,
} from "@zuse/contracts";
import { Effect } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
	effectiveChatRuntimeMode,
	resolveChatRuntimeMode,
} from "../../src/lib/auto-worktree.ts";
import { getActiveEnvironment } from "../../src/lib/rpc-client.ts";
import {
	resetSessionTimelineClientBusForTest,
	setSessionTimelineRpcClientForTest,
} from "../../src/lib/session-timeline-client-bus.ts";
import { useSettingsStore } from "../../src/lib/settings-client-bus.ts";

vi.mock("../../src/store/repository-settings.ts", () => ({
	repositorySettingsKey: (environmentId: string, projectId: string) =>
		`${environmentId}:${projectId}`,
	useRepositorySettingsStore: {
		getState: () => ({ byProject: {}, refresh: async () => null }),
	},
}));

afterEach(() => {
	resetSessionTimelineClientBusForTest();
	vi.unstubAllGlobals();
});

describe("effectiveChatRuntimeMode", () => {
	it("loads the user's Full Access default before creating a cloud draft", async () => {
		vi.stubGlobal("location", new URL("http://localhost"));
		const requested: EnvironmentId[] = [];
		setSessionTimelineRpcClientForTest(async (environmentId) => {
			requested.push(environmentId);
			return {
				"settings.get": () =>
					Effect.succeed(
						SettingsFile.make({
							...useSettingsStore.getState(),
							schemaVersion: 1,
							mcpDisabledServers: [],
							subagents: { enableForNewSessions: false, presets: {} },
							defaultRuntimeMode: "full-access",
						}),
					),
			} as never;
		});
		const environmentId = EnvironmentId.make("cloud-draft-origin");
		expect(
			await resolveChatRuntimeMode(environmentId, FolderId.make("project-1")),
		).toBe("full-access");
		expect(requested).toEqual([getActiveEnvironment()]);
	});
	it("lets a repository tighten but never loosen the runtime mode", () => {
		expect(
			effectiveChatRuntimeMode("approval-required", {
				defaultRuntimeMode: "full-access",
			} as RepositorySettings),
		).toBe("approval-required");
		expect(
			effectiveChatRuntimeMode("full-access", {
				defaultRuntimeMode: "approval-required",
			} as RepositorySettings),
		).toBe("approval-required");
		expect(
			effectiveChatRuntimeMode("auto-accept-edits-and-bash", {
				defaultRuntimeMode: "auto-accept-edits",
			} as RepositorySettings),
		).toBe("auto-accept-edits");
	});

	it("falls back to the global permission default", () => {
		expect(
			effectiveChatRuntimeMode("auto-accept-edits", {
				defaultRuntimeMode: null,
			} as RepositorySettings),
		).toBe("auto-accept-edits");
		expect(effectiveChatRuntimeMode("approval-required", null)).toBe(
			"approval-required",
		);
	});
});
