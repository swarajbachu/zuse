import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
	loadOrganizationWorkspaces,
	organizationWorkspacesAvailable,
	useOrganizationWorkspaces,
} from "../../src/lib/organization-workspaces.ts";
import { observeRendererAccount } from "../../src/lib/renderer-account.ts";

const request = vi.hoisted(() => vi.fn());
afterEach(() => vi.unstubAllEnvs());

it.each([
	[false, "https://api-staging.zuse.sh/", "false", true],
	[false, "https://api.zuse.sh", "true", true],
	[true, "https://api-staging.zuse.sh", undefined, true],
	[true, "https://api.zuse.sh", undefined, false],
	[false, "https://api-staging.zuse.sh", undefined, true],
	[true, undefined, undefined, true],
	[false, undefined, undefined, false],
	[false, "https://api.zuse.sh", "false", false],
	[true, "https://api-staging.zuse.sh", "false", true],
	[false, "https://api-staging.zuse.sh", "true", true],
])("workspace switcher availability: dev=%s api=%s flag=%s", (dev, api, flag, expected) => {
	vi.stubEnv("DEV", dev);
	vi.stubEnv("VITE_ZUSE_API_URL", api);
	vi.stubEnv("VITE_ORGANIZATION_WORKSPACES", flag);
	expect(organizationWorkspacesAvailable()).toBe(expected);
});
vi.mock("../../src/lib/organization-client.ts", () => ({
	runOrganizations: request,
}));

beforeEach(() => {
	observeRendererAccount(null);
	observeRendererAccount("alice");
	request.mockReset().mockResolvedValue([]);
});

it("deduplicates loads and caches only the current account's organizations", async () => {
	const first = loadOrganizationWorkspaces();
	expect(loadOrganizationWorkspaces()).toBe(first);
	await expect(first).resolves.toEqual([]);
	await loadOrganizationWorkspaces();
	expect(request).toHaveBeenCalledOnce();
	observeRendererAccount("bob");
	await loadOrganizationWorkspaces();
	expect(request).toHaveBeenCalledTimes(2);
});

it("does not issue an old account's request after the deferred module loads", async () => {
	const pending = loadOrganizationWorkspaces();
	observeRendererAccount("bob");
	await expect(pending).rejects.toThrow("account changed");
	expect(request).not.toHaveBeenCalled();
	expect(useOrganizationWorkspaces.getState()).toMatchObject({
		organizations: [],
		loading: false,
		error: null,
	});
});
