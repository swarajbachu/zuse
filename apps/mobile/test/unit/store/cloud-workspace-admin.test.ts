import { beforeEach, describe, expect, test } from "vitest";
import {
	cloudCatalogAtom,
	cloudWorkspaceAdminSnapshot,
	setCloudCatalogAccount,
	setCloudCatalogWorkspace,
} from "../../../src/store/cloud-catalog";
import { appAtomRegistry } from "../../../src/store/registry";

describe("shared workspace configuration authority", () => {
	beforeEach(() => {
		setCloudCatalogAccount(null);
		setCloudCatalogAccount("account-a");
		appAtomRegistry.update(cloudCatalogAtom, (catalog) => ({
			...catalog,
			organizations: [{ id: "org_a", name: "Team A", role: "admin" as const }],
		}));
	});
	test("retains Personal configuration access for its signed-in owner", () => {
		expect(cloudWorkspaceAdminSnapshot().isCurrent()).toBe(true);
	});
	test("organization admin authority is rechecked without waiting for an epoch change", () => {
		setCloudCatalogWorkspace({ kind: "organization", organizationId: "org_a" });
		const snapshot = cloudWorkspaceAdminSnapshot();
		expect(snapshot.isCurrent()).toBe(true);
		appAtomRegistry.update(cloudCatalogAtom, (catalog) => ({
			...catalog,
			organizations: [{ id: "org_a", name: "Team A", role: "member" as const }],
		}));
		expect(snapshot.isCurrent()).toBe(false);
	});
	test.each([
		"member",
		"billing",
	] as const)("%s cannot administer shared configuration", (role) => {
		setCloudCatalogWorkspace({ kind: "organization", organizationId: "org_a" });
		appAtomRegistry.update(cloudCatalogAtom, (catalog) => ({
			...catalog,
			organizations: [{ id: "org_a", name: "Team A", role }],
		}));
		expect(cloudWorkspaceAdminSnapshot().isCurrent()).toBe(false);
	});
	test("switching away and back invalidates a retained configuration form", () => {
		const snapshot = cloudWorkspaceAdminSnapshot();
		setCloudCatalogWorkspace({ kind: "organization", organizationId: "org_a" });
		setCloudCatalogWorkspace({ kind: "personal" });
		expect(snapshot.isCurrent()).toBe(false);
	});
	test("account replacement and logout invalidate configuration authority", () => {
		const snapshot = cloudWorkspaceAdminSnapshot();
		setCloudCatalogAccount("account-b");
		expect(snapshot.isCurrent()).toBe(false);
		setCloudCatalogAccount(null);
		expect(cloudWorkspaceAdminSnapshot().isCurrent()).toBe(false);
	});
});
