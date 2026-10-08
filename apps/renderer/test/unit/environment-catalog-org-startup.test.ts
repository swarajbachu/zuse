import { emptyResourceView } from "@zuse/client-runtime/resource-state";
import { EnvironmentId, Folder, FolderId } from "@zuse/contracts";
import { Effect } from "effect";
import { afterEach, expect, test, vi } from "vitest";

const folder = (id: string, workspaceKey?: string) =>
	Folder.make({
		id: FolderId.make(id),
		path: `/repos/${id}`,
		name: id,
		addedAt: new Date(0),
		...(workspaceKey === undefined ? {} : { workspaceKey }),
	});

// This desktop's server returns every workspace's projects in one shell.
const shell = vi.hoisted(() => ({ data: null as unknown }));

vi.mock("../../src/lib/runtime-operation-client.ts", () => ({
	runtimeOperationClient: async () => ({
		"connect.describe": () =>
			Effect.succeed({
				environmentId: EnvironmentId.make("this-desktop"),
				label: "Laptop",
			}),
		"environments.list": () => Effect.succeed({ environments: [] }),
	}),
}));
vi.mock("../../src/lib/environment-shell-client-bus.ts", async (original) => {
	const actual =
		await original<
			typeof import("../../src/lib/environment-shell-client-bus.ts")
		>();
	const { scopeEnvironmentShellView } = await import(
		"../../src/lib/environment-shell-scope.ts"
	);
	const { rendererWorkspaceSnapshot } = await import(
		"../../src/lib/renderer-workspace.ts"
	);
	const view = () => ({ ...emptyResourceView(), data: shell.data });
	return {
		...actual,
		retainEnvironmentShell: () => ({
			lease: { release: () => undefined, activate: () => undefined },
		}),
		subscribeEnvironmentShell: () => () => undefined,
		environmentShellSnapshot: (ref: { environmentId: string }) =>
			scopeEnvironmentShellView(
				ref.environmentId,
				view() as never,
				rendererWorkspaceSnapshot().scope,
			),
	};
});

import { observeRendererAccount } from "../../src/lib/renderer-account.ts";
import { selectRendererWorkspace } from "../../src/lib/renderer-workspace.ts";
import { environmentBelongsToWorkspace } from "../../src/lib/rpc-client.ts";
import { useEnvironmentCatalogStore } from "../../src/store/environment-catalog.ts";
import { useWorkspaceStore } from "../../src/store/workspace.ts";

afterEach(() => {
	observeRendererAccount(null);
	vi.unstubAllGlobals();
});

test("organization startup shows only this desktop's projects linked to the organization", async () => {
	vi.stubGlobal("location", new URL("http://localhost:3000"));
	vi.stubGlobal("window", {});
	shell.data = {
		folders: [
			folder("personal-repo"),
			folder("org-repo", "organization:org-test"),
		],
		originsByFolder: {},
		chatsByProject: { "personal-repo": [], "org-repo": [] },
		sessionsByProject: { "personal-repo": [], "org-repo": [] },
		creationOperationsByProject: {},
	};
	observeRendererAccount("test-user");
	selectRendererWorkspace({ kind: "organization", organizationId: "org-test" });
	useEnvironmentCatalogStore.setState({
		initialized: false,
		initializing: false,
		entries: [],
		initializationError: null,
	});
	await expect(
		useEnvironmentCatalogStore.getState().initialize(),
	).resolves.toBeUndefined();
	expect(useEnvironmentCatalogStore.getState().initializationError).toBeNull();
	expect(environmentBelongsToWorkspace("this-desktop")).toBe(true);
	expect(useWorkspaceStore.getState().folders.map((f) => f.id)).toEqual([
		"org-repo",
	]);

	// Switching workspace re-projects the same desktop for the new owner.
	selectRendererWorkspace({ kind: "personal" });
	expect(useWorkspaceStore.getState().folders.map((f) => f.id)).toEqual([
		"personal-repo",
	]);
	expect(useWorkspaceStore.getState().selectedFolderId).toBe("personal-repo");
	selectRendererWorkspace({ kind: "organization", organizationId: "other" });
	expect(useWorkspaceStore.getState().folders).toEqual([]);
});
