import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
	loadOrganizationWorkspaces,
	organizationWorkspacesAvailable,
	useOrganizationWorkspaces,
} from "../../src/lib/organization-workspaces.ts";
import { observeRendererAccount } from "../../src/lib/renderer-account.ts";
import {
	rendererWorkspaceSnapshot,
	selectRendererWorkspace,
} from "../../src/lib/renderer-workspace.ts";

const request = vi.hoisted(() => vi.fn());
afterEach(() => {
	vi.unstubAllEnvs();
	vi.useRealTimers();
});

it.each([
	[false, "https://api-staging.zuse.sh/", "false", true],
	[false, "https://api.zuse.sh", "true", false],
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
	request
		.mockReset()
		.mockResolvedValue({ organizations: [], canCreate: false });
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

it("enables production team members without the build flag or individual creation approval", async () => {
	vi.stubEnv("DEV", false);
	vi.stubEnv("VITE_ZUSE_API_URL", "https://api.zuse.sh");
	vi.stubEnv("VITE_ORGANIZATION_WORKSPACES", "false");
	request.mockResolvedValue({
		canCreate: false,
		organizations: [{ id: "org-a", name: "Team", role: "member" }],
	});
	expect(organizationWorkspacesAvailable()).toBe(false);
	await loadOrganizationWorkspaces();
	expect(organizationWorkspacesAvailable()).toBe(true);
	expect(useOrganizationWorkspaces.getState().canCreate).toBe(false);
	observeRendererAccount("bob");
	expect(organizationWorkspacesAvailable()).toBe(false);
});

it("backend denial overrides staging and build hints", async () => {
	vi.stubEnv("VITE_ZUSE_API_URL", "https://api-staging.zuse.sh");
	vi.stubEnv("VITE_ORGANIZATION_WORKSPACES", "true");
	await loadOrganizationWorkspaces();
	expect(organizationWorkspacesAvailable()).toBe(false);
});

it("expires capabilities and clears approval after a refresh fails", async () => {
	vi.useFakeTimers();
	request.mockResolvedValue({ organizations: [], canCreate: true });
	await loadOrganizationWorkspaces();
	expect(organizationWorkspacesAvailable()).toBe(true);
	vi.advanceTimersByTime(30_001);
	request.mockRejectedValue(new Error("network unavailable"));
	await expect(loadOrganizationWorkspaces()).rejects.toThrow(
		"network unavailable",
	);
	expect(organizationWorkspacesAvailable()).toBe(false);
	expect(useOrganizationWorkspaces.getState()).toMatchObject({
		canCreate: false,
		organizations: [],
		loading: false,
	});
	request.mockResolvedValue({ organizations: [], canCreate: true });
	await loadOrganizationWorkspaces();
	expect(organizationWorkspacesAvailable()).toBe(true);
});

it("ignores an old account's late capability response", async () => {
	let resolve!: (value: { organizations: never[]; canCreate: boolean }) => void;
	request.mockReturnValue(
		new Promise((done) => {
			resolve = done;
		}),
	);
	const old = loadOrganizationWorkspaces();
	await vi.waitFor(() => expect(request).toHaveBeenCalledOnce());
	observeRendererAccount("bob");
	request.mockResolvedValue({ organizations: [], canCreate: false });
	await loadOrganizationWorkspaces();
	resolve({ organizations: [], canCreate: true });
	await expect(old).rejects.toThrow("account changed");
	expect(useOrganizationWorkspaces.getState().canCreate).toBe(false);
});

it("returns to Personal when a refreshed catalog removes the selected team", async () => {
	request.mockResolvedValue({
		canCreate: false,
		organizations: [{ id: "org-a", name: "Team", role: "member" }],
	});
	await loadOrganizationWorkspaces();
	selectRendererWorkspace({ kind: "organization", organizationId: "org-a" });
	request.mockResolvedValue({ canCreate: false, organizations: [] });
	await loadOrganizationWorkspaces(true);
	expect(rendererWorkspaceSnapshot().scope).toEqual({ kind: "personal" });
});

it("returns to Personal when a selected team's capability refresh fails", async () => {
	request.mockResolvedValue({
		canCreate: false,
		organizations: [{ id: "org-a", name: "Team", role: "member" }],
	});
	await loadOrganizationWorkspaces();
	selectRendererWorkspace({ kind: "organization", organizationId: "org-a" });
	request.mockRejectedValue(new Error("network unavailable"));
	await expect(loadOrganizationWorkspaces(true)).rejects.toThrow(
		"network unavailable",
	);
	expect(rendererWorkspaceSnapshot().scope).toEqual({ kind: "personal" });
	expect(organizationWorkspacesAvailable()).toBe(false);
});
