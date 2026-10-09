import { EnvironmentId, FolderId, RepositorySettings } from "@zuse/contracts";
import { beforeEach, expect, it, vi } from "vitest";

const dispatch = vi.hoisted(() => vi.fn());
vi.mock("../../src/lib/environment-shell-client-bus.ts", () => ({
	dispatchEnvironmentShellCommand: dispatch,
}));

import { observeRendererAccount } from "../../src/lib/renderer-account.ts";
import { selectRendererWorkspace } from "../../src/lib/renderer-workspace.ts";
import {
	repositorySettingsKey,
	useRepositorySettingsStore,
} from "../../src/store/repository-settings.ts";

const environmentId = EnvironmentId.make("environment");
const projectId = FolderId.make("project");
const settings = RepositorySettings.make({
	projectId,
	defaultProviderId: null,
	defaultModel: null,
	defaultRuntimeMode: null,
	autoCreateWorktree: false,
	worktreeBaseDir: null,
	archiveCleanupScript: null,
	setupScript: "bun install",
	runScript: "bun dev",
	autoRunAfterSetup: false,
	environmentVariables: { WORKSPACE_VALUE: "personal" },
	cloudEnvironmentVariables: {},
	fileIncludeGlobs: "",
	mcpDisabledServers: [],
	trusted: true,
	gatedConfig: null,
});

beforeEach(() => {
	observeRendererAccount(null);
	observeRendererAccount("alice");
	dispatch.mockReset().mockResolvedValue({ result: settings });
});

it("retains the existing runtime commands and patch payloads", async () => {
	const store = useRepositorySettingsStore.getState();
	expect(await store.refresh(environmentId, projectId)).toEqual(settings);
	expect(dispatch).toHaveBeenLastCalledWith(
		expect.objectContaining({
			environmentId,
			kind: "repositorySettings.get",
			payload: { projectId },
		}),
	);
	await store.update(environmentId, projectId, { setupScript: null });
	expect(dispatch).toHaveBeenLastCalledWith(
		expect.objectContaining({
			environmentId,
			kind: "repositorySettings.update",
			payload: { projectId, patch: { setupScript: null } },
		}),
	);
	expect(
		useRepositorySettingsStore.getState().byProject[
			repositorySettingsKey(environmentId, projectId)
		],
	).toEqual(settings);
});

it("clears scripts and environment values when changing workspace or account", async () => {
	await useRepositorySettingsStore.getState().refresh(environmentId, projectId);
	selectRendererWorkspace({ kind: "organization", organizationId: "org_a" });
	expect(useRepositorySettingsStore.getState().byProject).toEqual({});
	await useRepositorySettingsStore.getState().refresh(environmentId, projectId);
	observeRendererAccount("bob");
	expect(useRepositorySettingsStore.getState().byProject).toEqual({});
});

it.each([
	"refresh",
	"update",
] as const)("discards a late %s result even after returning to the original workspace", async (method) => {
	const pending = Promise.withResolvers<{ result: RepositorySettings }>();
	dispatch.mockReturnValueOnce(pending.promise);
	const request =
		method === "refresh"
			? useRepositorySettingsStore.getState().refresh(environmentId, projectId)
			: useRepositorySettingsStore
					.getState()
					.update(environmentId, projectId, { setupScript: "old" });
	selectRendererWorkspace({ kind: "organization", organizationId: "org_a" });
	selectRendererWorkspace({ kind: "personal" });
	pending.resolve({ result: settings });
	expect(await request).toBeNull();
	expect(useRepositorySettingsStore.getState().byProject).toEqual({});
});

it("does not publish an old request error into a different account", async () => {
	const pending = Promise.withResolvers<never>();
	dispatch.mockReturnValueOnce(pending.promise);
	const request = useRepositorySettingsStore
		.getState()
		.refresh(environmentId, projectId);
	observeRendererAccount("bob");
	pending.reject(new Error("old account failure"));
	expect(await request).toBeNull();
	expect(useRepositorySettingsStore.getState().error).toBeNull();
});
