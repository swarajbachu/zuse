import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
	environmentId: "local",
	requested: [] as Array<string | null>,
}));
vi.mock("../../src/store/environment-catalog.ts", () => ({
	useEnvironmentCatalogStore: (
		selector: (value: { activeEnvironmentId: string }) => unknown,
	) => selector({ activeEnvironmentId: state.environmentId }),
}));
vi.mock("../../src/lib/environment-shell-client-bus.ts", async () => {
	// Exercise the real workspace filter that the shell bus applies to reads.
	const { scopeEnvironmentShell } = await import(
		"../../src/lib/environment-shell-scope.ts"
	);
	const { rendererWorkspaceSnapshot } = await import(
		"../../src/lib/renderer-workspace.ts"
	);
	const shell = {
		folders: [
			{ id: "repo", name: "Secret repository" },
			{
				id: "org-repo",
				name: "Org repository",
				workspaceKey: "organization:org-a",
			},
		],
		chatsByProject: {
			repo: [{ title: "Secret chat" }],
			"org-repo": [{ title: "Org chat" }],
		},
		sessionsByProject: {},
		originsByFolder: {},
		creationOperationsByProject: {},
	} as never;
	return {
		useEnvironmentShellResource: (
			environmentId: string | null,
			_activation: string,
			workspaces: "selected" | "all" = "selected",
		) => {
			state.requested.push(environmentId);
			if (environmentId === null) return { data: null };
			return {
				data:
					workspaces === "all"
						? shell
						: scopeEnvironmentShell(
								environmentId,
								shell,
								rendererWorkspaceSnapshot().scope,
							),
			};
		},
	};
});

import {
	useActiveEnvironmentEntities,
	useEnvironmentEntities,
} from "../../src/lib/environment-entity-hooks.ts";
import {
	observeRendererAccount,
	rendererAccountSnapshot,
} from "../../src/lib/renderer-account.ts";
import { selectRendererWorkspace } from "../../src/lib/renderer-workspace.ts";
import { registerCloudWorkspace } from "../../src/lib/rpc-client.ts";

const Content = ({ background = false }: { background?: boolean }) => {
	const visible = useActiveEnvironmentEntities();
	const explicit = useEnvironmentEntities("local", background, "all");
	const entities = background ? explicit : visible;
	return (
		<div>
			{entities.folders.map((folder) => folder.name).join(",")}
			{Object.values(entities.chatsByProject)
				.flat()
				.map((chat) => chat.title)
				.join(",")}
		</div>
	);
};

beforeEach(() => {
	observeRendererAccount(null);
	observeRendererAccount("alice");
	selectRendererWorkspace({ kind: "personal" });
	state.environmentId = "local";
	state.requested = [];
});

it("shows only the selected workspace's projects from this desktop", () => {
	const personal = renderToStaticMarkup(<Content />);
	expect(personal).toContain("Secret chat");
	expect(personal).not.toContain("Org");
	selectRendererWorkspace({ kind: "organization", organizationId: "org-a" });
	const org = renderToStaticMarkup(<Content />);
	expect(org).toContain("Org repository");
	expect(org).toContain("Org chat");
	expect(org).not.toContain("Secret");
	selectRendererWorkspace({ kind: "organization", organizationId: "org-b" });
	expect(renderToStaticMarkup(<Content />)).toBe("<div></div>");
	selectRendererWorkspace({ kind: "personal" });
	expect(renderToStaticMarkup(<Content />)).toContain("Secret repository");
});

it("keeps explicitly scoped background activity independent of the selected workspace", () => {
	selectRendererWorkspace({ kind: "organization", organizationId: "org-a" });
	expect(renderToStaticMarkup(<Content background />)).toContain("Secret chat");
});

it("shows a registered cloud environment only in its owning organization", () => {
	const ticket = {
		workspaceId: "cloud-a",
		workspaceScope: { kind: "organization" as const, organizationId: "org-a" },
		wsUrl: "wss://example.test/cloud",
		protocol: "zuse-workspace-v1",
		role: "client" as const,
		generation: 1,
		gatewayEpoch: 1,
		credential: "test-ticket",
		expiresAt: Date.now() + 60_000,
	};
	registerCloudWorkspace(
		ticket.workspaceId,
		ticket,
		async () => ticket,
		rendererAccountSnapshot(),
	);
	state.environmentId = ticket.workspaceId;
	expect(renderToStaticMarkup(<Content />)).toBe("<div></div>");
	selectRendererWorkspace({ kind: "organization", organizationId: "org-a" });
	expect(renderToStaticMarkup(<Content />)).toContain("Secret chat");
	selectRendererWorkspace({ kind: "organization", organizationId: "org-b" });
	expect(renderToStaticMarkup(<Content />)).toBe("<div></div>");
});
