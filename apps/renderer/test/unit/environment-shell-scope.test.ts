import { emptyResourceView } from "@zuse/client-runtime/resource-state";
import { Folder, FolderId } from "@zuse/contracts";
import { expect, it } from "vitest";
import { mergeCloudProjectFolders } from "../../src/lib/cloud-project-folders.ts";
import type { EnvironmentShellData } from "../../src/lib/environment-shell-client-bus.ts";
import {
	scopeEnvironmentShell,
	scopeEnvironmentShellView,
} from "../../src/lib/environment-shell-scope.ts";

const folder = (id: string, workspaceKey?: string) =>
	Folder.make({
		id: FolderId.make(id),
		path: `/repos/${id}`,
		name: id,
		addedAt: new Date(0),
		...(workspaceKey === undefined ? {} : { workspaceKey }),
	});

const shell: EnvironmentShellData = {
	folders: [folder("legacy"), folder("org", "organization:acme")],
	originsByFolder: {
		legacy: null,
		org: { host: "github.com", owner: "acme", repo: "app" } as never,
	},
	chatsByProject: { legacy: [{ id: "a" }], org: [{ id: "b" }] } as never,
	sessionsByProject: { legacy: [{ id: "s1" }], org: [{ id: "s2" }] } as never,
	creationOperationsByProject: { legacy: [], org: [] },
};
const acme = { kind: "organization", organizationId: "acme" } as const;

it("keeps only the selected workspace's projects and everything under them", () => {
	const scoped = scopeEnvironmentShell("local", shell, acme);
	expect(scoped.folders.map((f) => f.id)).toEqual(["org"]);
	expect(Object.keys(scoped.chatsByProject)).toEqual(["org"]);
	expect(Object.keys(scoped.sessionsByProject)).toEqual(["org"]);
	expect(Object.keys(scoped.originsByFolder)).toEqual(["org"]);
	expect(Object.keys(scoped.creationOperationsByProject)).toEqual(["org"]);
});

it("treats projects without a recorded owner as Personal", () => {
	const scoped = scopeEnvironmentShell("local", shell, { kind: "personal" });
	expect(scoped.folders.map((f) => f.id)).toEqual(["legacy"]);
});

it("leaves environments that belong to a single workspace untouched", () => {
	expect(scopeEnvironmentShell("ssh-box", shell, acme)).toBe(shell);
});

it("returns stable scoped views per workspace", () => {
	const view = { ...emptyResourceView<EnvironmentShellData>(), data: shell };
	const first = scopeEnvironmentShellView("local", view, acme);
	expect(scopeEnvironmentShellView("local", view, acme)).toBe(first);
	expect(
		scopeEnvironmentShellView("local", view, { kind: "personal" }),
	).not.toBe(first);
});

it("merges an organization's local checkout with its cloud project", () => {
	const scoped = scopeEnvironmentShell("local", shell, acme);
	const merged = mergeCloudProjectFolders(
		scoped.folders,
		scoped.originsByFolder,
		[{ projectId: "p1", repositoryIdentity: "github.com/acme/app" } as never],
	);
	// The cloud project is represented by the local checkout, not duplicated.
	expect(merged.folders.map((f) => f.id)).toEqual(["org"]);
});
