import { beforeEach, expect, test, vi } from "vitest";

const api = vi.hoisted(() => ({
	list: vi.fn(),
	status: vi.fn(),
	connect: vi.fn(),
	add: vi.fn(),
}));
vi.mock("~/rpc/api-client", () => ({
	listEnvironments: api.list,
	getEnvironmentStatus: api.status,
	connectEnvironment: api.connect,
}));
vi.mock("~/store/connections", () => ({ addApiConnection: api.add }));

import {
	setCloudCatalogAccount,
	setCloudCatalogWorkspace,
} from "../../../src/store/cloud-catalog";
import {
	connectToEnvironment,
	environmentsAtom,
	environmentsLoadingAtom,
	refreshEnvironments,
	resetEnvironmentsRuntime,
} from "../../../src/store/environments";
import { appAtomRegistry } from "../../../src/store/registry";

const computers = {
	environments: [{ environmentId: "laptop", label: "Personal laptop" }],
};
beforeEach(() => {
	resetEnvironmentsRuntime();
	setCloudCatalogAccount(null);
	setCloudCatalogAccount("alice");
	api.list.mockReset().mockResolvedValue(computers);
	api.status.mockReset().mockResolvedValue({ status: "online" });
	api.connect.mockReset();
	api.add.mockReset();
});

test("organization selection hides Personal discovery and prevents Personal connection grants", async () => {
	await refreshEnvironments();
	expect(appAtomRegistry.get(environmentsAtom)).toHaveLength(1);
	setCloudCatalogWorkspace({ kind: "organization", organizationId: "org_a" });
	expect(appAtomRegistry.get(environmentsAtom)).toEqual([]);
	await refreshEnvironments();
	expect(api.list).toHaveBeenCalledTimes(1);
	await expect(connectToEnvironment("laptop")).rejects.toThrow("Personal");
	expect(api.connect).not.toHaveBeenCalled();
	setCloudCatalogWorkspace({ kind: "personal" });
	expect(appAtomRegistry.get(environmentsAtom)).toHaveLength(1);
});

test("ignores discovery that crosses a workspace switch, even after returning to Personal", async () => {
	const late = Promise.withResolvers<typeof computers>();
	api.list.mockReturnValueOnce(late.promise);
	const pending = refreshEnvironments();
	setCloudCatalogWorkspace({ kind: "organization", organizationId: "org_a" });
	setCloudCatalogWorkspace({ kind: "personal" });
	late.resolve(computers);
	await pending;
	expect(appAtomRegistry.get(environmentsAtom)).toEqual([]);
	expect(appAtomRegistry.get(environmentsLoadingAtom)).toBe(false);
	expect(api.status).not.toHaveBeenCalled();
});

test("does not register a Personal connection grant after a workspace switch", async () => {
	const late = Promise.withResolvers<unknown>();
	api.connect.mockReturnValueOnce(late.promise);
	const pending = connectToEnvironment("laptop");
	setCloudCatalogWorkspace({ kind: "organization", organizationId: "org_a" });
	late.resolve({
		endpoint: { wsBaseUrl: "wss://laptop.test" },
		connectToken: "test-ticket",
	});
	await expect(pending).rejects.toThrow("Workspace changed");
	expect(api.add).not.toHaveBeenCalled();
});
