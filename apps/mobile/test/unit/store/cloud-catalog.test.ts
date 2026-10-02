import { AgentSessionId, CloudWorkspaceOpError } from "@zuse/contracts";
import { Effect, Schema } from "effect";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { SessionsSnapshot } from "../../../src/offline/sessions-snapshot";
import {
	cloudControlClientForWorkspace,
	organizationControlClientForAccount,
} from "../../../src/rpc/api-client";
import { summary, workspace } from "../../fixtures/cloud";

const api = vi.hoisted(() => ({
	list: vi.fn(),
	auth: vi.fn(),
	organizations: vi.fn(),
}));
vi.mock("~/rpc/api-client", () => ({
	organizationControlClientForAccount: vi.fn(() => ({
		"organizations.list": () => Effect.promise(api.organizations),
	})),
	cloudControlClientForWorkspace: vi.fn(() => ({
		"cloud.chats.list": () => Effect.promise(api.list),
		"cloud.projects.list": () => Effect.succeed({ projects: [] }),
		"cloud.auth.status": () => Effect.tryPromise(api.auth),
		"cloud.image.status": () => Effect.succeed(null),
		"machines.entitlements": () => Effect.succeed({ entitlements: [] }),
		"cloud.providers": () =>
			Effect.succeed({
				providers: [
					{ providerId: "e2b", displayName: "E2B" },
					{ providerId: "boxd", displayName: "boxd" },
				],
			}),
	})),
}));

import { availableConnections } from "../../../src/lib/connection-records";
import {
	cloudAuthenticatedProvidersAtom,
	cloudCatalogAtom,
	cloudCatalogBundles,
	cloudCatalogGeneration,
	cloudConnectionsAtom,
	refreshCloudCatalog,
	refreshCloudOrganizations,
	registerCloudSummary,
	selectCloudWorkspace,
	setCloudCatalogAccount,
	setCloudCatalogWorkspace,
} from "../../../src/store/cloud-catalog";
import { appAtomRegistry } from "../../../src/store/registry";

describe("account-owned mobile cloud catalog", () => {
	beforeEach(() => {
		api.organizations.mockReset().mockResolvedValue([]);
		vi.mocked(cloudControlClientForWorkspace).mockClear();
		vi.mocked(organizationControlClientForAccount).mockClear();
		setCloudCatalogAccount(null);
		setCloudCatalogAccount("account-1");
		api.list.mockReset().mockResolvedValue({ chats: [summary()] });
		api.auth.mockReset().mockResolvedValue({
			providers: [
				{ providerId: "codex", state: "connected" },
				{ providerId: "claude", state: "disconnected" },
			],
		});
	});
	test("loads memberships once per concurrent request and retains billing-only roles", async () => {
		const organizations = [
			{ id: "org_a", name: "Team A", role: "member" },
			{ id: "org_b", name: "Finance", role: "billing" },
		];
		api.organizations.mockResolvedValue(organizations);
		await Promise.all([
			refreshCloudOrganizations(),
			refreshCloudOrganizations(),
		]);
		expect(api.organizations).toHaveBeenCalledOnce();
		expect(organizationControlClientForAccount).toHaveBeenCalledOnce();
		expect(appAtomRegistry.get(cloudCatalogAtom).organizations).toEqual(
			organizations,
		);
		setCloudCatalogWorkspace({ kind: "organization", organizationId: "org_a" });
		expect(appAtomRegistry.get(cloudCatalogAtom).organizations).toEqual(
			organizations,
		);
	});
	test("discards old-account memberships even if the user returns to the same account", async () => {
		const late = Promise.withResolvers<unknown[]>();
		api.organizations.mockReturnValueOnce(late.promise);
		const pending = refreshCloudOrganizations();
		await vi.waitFor(() => expect(api.organizations).toHaveBeenCalled());
		setCloudCatalogAccount("account-2");
		setCloudCatalogAccount("account-1");
		late.resolve([{ id: "org_a", name: "Stale", role: "admin" }]);
		await expect(pending).rejects.toThrow("account changed");
		expect(appAtomRegistry.get(cloudCatalogAtom).organizations).toEqual([]);
	});
	test("switches the complete catalog scope without reusing Personal resources", async () => {
		await refreshCloudCatalog();
		const scope = { kind: "organization", organizationId: "org_a" } as const;
		setCloudCatalogWorkspace(scope);
		expect(appAtomRegistry.get(cloudCatalogAtom)).toMatchObject({
			scope,
			chats: [],
			projects: [],
			image: null,
			auth: null,
		});
		api.list.mockResolvedValue({
			chats: [{ ...summary(), workspaceScope: scope }],
		});
		await refreshCloudCatalog();
		expect(cloudControlClientForWorkspace).toHaveBeenLastCalledWith(scope);
		expect(appAtomRegistry.get(cloudCatalogAtom).chats).toHaveLength(1);
	});
	test("selection verifies current membership before changing workspace", async () => {
		await expect(
			selectCloudWorkspace({
				kind: "organization",
				organizationId: "org_missing",
			}),
		).rejects.toThrow("no longer available");
		expect(appAtomRegistry.get(cloudCatalogAtom).scope).toEqual({
			kind: "personal",
		});
		api.organizations.mockResolvedValue([
			{ id: "org_a", name: "Team A", role: "member" },
		]);
		await selectCloudWorkspace({
			kind: "organization",
			organizationId: "org_a",
		});
		expect(appAtomRegistry.get(cloudCatalogAtom).scope).toEqual({
			kind: "organization",
			organizationId: "org_a",
		});
	});
	test("a late organization selection cannot replace a newer Personal selection", async () => {
		const response = Promise.withResolvers<unknown[]>();
		api.organizations.mockReturnValueOnce(response.promise);
		const pending = selectCloudWorkspace({
			kind: "organization",
			organizationId: "org_a",
		});
		await vi.waitFor(() => expect(api.organizations).toHaveBeenCalled());
		await selectCloudWorkspace({ kind: "personal" });
		response.resolve([{ id: "org_a", name: "Team A", role: "admin" }]);
		await expect(pending).rejects.toThrow("selection changed");
		expect(appAtomRegistry.get(cloudCatalogAtom).scope).toEqual({
			kind: "personal",
		});
	});
	test("finance-only selection never requests content", async () => {
		api.organizations.mockResolvedValue([
			{ id: "org_a", name: "Finance", role: "billing" },
		]);
		await selectCloudWorkspace({
			kind: "organization",
			organizationId: "org_a",
		});
		await refreshCloudCatalog();
		expect(api.list).not.toHaveBeenCalled();
		expect(api.auth).not.toHaveBeenCalled();
		expect(appAtomRegistry.get(cloudCatalogAtom).loading).toBe(false);
		const epoch = cloudCatalogGeneration();
		await refreshCloudOrganizations();
		expect(cloudCatalogGeneration()).toBe(epoch);
	});
	test.each([
		"member",
		"billing",
		"removed",
	])("a membership change to %s clears content and fences an in-flight catalog", async (role) => {
		const scope = { kind: "organization", organizationId: "org_a" } as const;
		api.organizations.mockResolvedValue([
			{ id: "org_a", name: "Team", role: "admin" },
		]);
		await selectCloudWorkspace(scope);
		api.list.mockResolvedValue({
			chats: [{ ...summary(), workspaceScope: scope }],
		});
		await refreshCloudCatalog();
		expect(appAtomRegistry.get(cloudCatalogAtom).chats).toHaveLength(1);
		const response = Promise.withResolvers<unknown>();
		api.list.mockReturnValueOnce(response.promise);
		const pending = refreshCloudCatalog();
		await vi.waitFor(() => expect(api.list).toHaveBeenCalledTimes(2));
		api.organizations.mockResolvedValue(
			role === "removed" ? [] : [{ id: "org_a", name: "Finance", role }],
		);
		await refreshCloudOrganizations();
		response.resolve({ chats: [{ ...summary(), workspaceScope: scope }] });
		await pending;
		expect(appAtomRegistry.get(cloudCatalogAtom)).toMatchObject({
			scope,
			chats: [],
			projects: [],
			auth: null,
			loading: false,
		});
	});
	test("catalog authorization failures retain the account's workspace list", async () => {
		const organizations = [{ id: "org_a", name: "Team", role: "member" }];
		api.organizations.mockResolvedValue(organizations);
		await refreshCloudOrganizations();
		api.list.mockRejectedValueOnce(
			new CloudWorkspaceOpError({ code: "not-allowed" }),
		);
		await refreshCloudCatalog();
		expect(appAtomRegistry.get(cloudCatalogAtom).organizations).toEqual(
			organizations,
		);
	});
	test("client initialization errors clear loading and allow retry", async () => {
		vi.mocked(cloudControlClientForWorkspace).mockImplementationOnce(() => {
			throw new Error("unavailable");
		});
		await refreshCloudCatalog();
		expect(appAtomRegistry.get(cloudCatalogAtom)).toMatchObject({
			loading: false,
			error: "Could not refresh cloud chats. Pull to retry.",
		});
		await refreshCloudCatalog();
		expect(appAtomRegistry.get(cloudCatalogAtom)).toMatchObject({
			loading: false,
			error: null,
		});
		expect(appAtomRegistry.get(cloudCatalogAtom).chats).toHaveLength(1);
	});
	test("rejects catalogs containing another workspace's chats", async () => {
		setCloudCatalogWorkspace({ kind: "organization", organizationId: "org_a" });
		await refreshCloudCatalog();
		expect(appAtomRegistry.get(cloudCatalogAtom).chats).toEqual([]);
		expect(appAtomRegistry.get(cloudCatalogAtom).error).toContain(
			"different workspace",
		);
	});
	test("clears cached content after an authoritative access denial", async () => {
		await refreshCloudCatalog();
		expect(appAtomRegistry.get(cloudCatalogAtom).chats).toHaveLength(1);
		api.list.mockRejectedValueOnce(
			new CloudWorkspaceOpError({ code: "not-allowed" }),
		);
		await refreshCloudCatalog();
		expect(appAtomRegistry.get(cloudCatalogAtom)).toMatchObject({
			chats: [],
			projects: [],
			auth: null,
			image: null,
			loading: false,
		});
	});
	test("ignores an old response after switching away and back", async () => {
		const old = Promise.withResolvers<{
			chats: ReturnType<typeof summary>[];
		}>();
		api.list.mockReturnValueOnce(old.promise);
		const pending = refreshCloudCatalog();
		await vi.waitFor(() => expect(api.list).toHaveBeenCalled());
		setCloudCatalogWorkspace({ kind: "organization", organizationId: "org_a" });
		setCloudCatalogWorkspace({ kind: "personal" });
		old.resolve({ chats: [summary()] });
		await pending;
		expect(appAtomRegistry.get(cloudCatalogAtom).chats).toEqual([]);
	});
	test("lists account chats with zero devices and preserves runtime access defaults", async () => {
		await refreshCloudCatalog();
		const connections = appAtomRegistry.get(cloudConnectionsAtom);
		expect(connections).toHaveLength(1);
		expect(connections[0]).toMatchObject({
			source: "cloud",
			cloudWorkspaceId: "workspace-1",
			environmentId: "workspace-1",
		});
		const bundles = cloudCatalogBundles(
			appAtomRegistry.get(cloudCatalogAtom).chats,
			{},
		);
		expect(bundles["cloud:workspace-1"]?.[0]?.sessions[0]).toMatchObject({
			id: "session-1",
			runtimeMode: "full-access",
		});
		expect(availableConnections(connections, false)).toEqual([]);
		// Sandbox providers feed the new-chat "Cloud · …" destinations.
		expect(
			appAtomRegistry
				.get(cloudCatalogAtom)
				.providers.map((provider) => provider.providerId),
		).toEqual(["e2b", "boxd"]);
	});
	test("restores JSON cache dates before merging a newer cloud summary", () => {
		const row = summary();
		const initial = cloudCatalogBundles([row], {})["cloud:workspace-1"]?.[0];
		if (!initial) throw new Error("Missing cloud fixture");
		const snapshot = {
			projects: [initial.project],
			chats: initial.chats,
			sessions: initial.sessions,
			savedAt: 1,
		};
		// Existing cache files were written directly with JSON.stringify.
		const restored = Schema.decodeUnknownSync(SessionsSnapshot)(
			JSON.parse(JSON.stringify(snapshot)),
		);
		expect(restored.chats[0]?.updatedAt).toBeInstanceOf(Date);
		expect(restored.projects[0]?.addedAt).toBeInstanceOf(Date);
		expect(restored.sessions[0]?.createdAt).toBeInstanceOf(Date);
		const bundles = cloudCatalogBundles(
			[
				{
					...row,
					updatedAt: row.updatedAt + 100,
					activeSessionId: row.initialSessionId,
					title: "Updated title",
				},
			],
			{
				"cloud:workspace-1": [
					{
						...initial,
						chats: [...restored.chats],
						sessions: [...restored.sessions],
					},
				],
			},
		);
		expect(bundles["cloud:workspace-1"]?.[0]?.chats[0]?.title).toBe(
			"Updated title",
		);
		expect(
			Schema.decodeUnknownSync(SessionsSnapshot)(
				Schema.encodeSync(SessionsSnapshot)(restored),
			),
		).toEqual(restored);
	});
	test("rejects malformed snapshot dates rather than putting them in the store", () => {
		const initial = cloudCatalogBundles([summary()], {})[
			"cloud:workspace-1"
		]?.[0];
		if (!initial) throw new Error("Missing cloud fixture");
		expect(() =>
			Schema.decodeUnknownSync(SessionsSnapshot)({
				projects: [],
				sessions: [],
				chats: [
					{
						...JSON.parse(JSON.stringify(initial.chats[0])),
						updatedAt: "invalid",
					},
				],
				savedAt: 1,
			}),
		).toThrow();
	});

	test("deduplicates concurrent catalog requests", async () => {
		await Promise.all([refreshCloudCatalog(), refreshCloudCatalog()]);
		expect(api.list).toHaveBeenCalledTimes(1);
	});
	test("keeps a new launch when an older in-flight list omits it", async () => {
		let finish!: (value: unknown) => void;
		api.list.mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					finish = resolve;
				}),
		);
		const refresh = refreshCloudCatalog();
		await vi.waitFor(() => expect(api.list).toHaveBeenCalled());
		registerCloudSummary(
			summary(workspace({ workspaceId: "created-during-fetch" })),
		);
		finish({ chats: [] });
		await refresh;
		expect(appAtomRegistry.get(cloudCatalogAtom).chats[0]?.workspaceId).toBe(
			"created-during-fetch",
		);
	});
	test("fences late results after signing into a different account", async () => {
		let finish!: (value: unknown) => void;
		api.list.mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					finish = resolve;
				}),
		);
		const refresh = refreshCloudCatalog();
		await vi.waitFor(() => expect(api.list).toHaveBeenCalled());
		setCloudCatalogAccount("account-2");
		finish({ chats: [summary()] });
		await refresh;
		expect(appAtomRegistry.get(cloudCatalogAtom)).toMatchObject({
			accountId: "account-2",
			chats: [],
		});
	});
	test("does not regress lifecycle revisions", async () => {
		registerCloudSummary(
			summary(
				workspace({ revision: 4, state: "ready", runtimeState: "online" }),
			),
		);
		await refreshCloudCatalog();
		expect(appAtomRegistry.get(cloudCatalogAtom).chats[0]?.revision).toBe(4);
	});
	test("does not resurrect a removed initial session", () => {
		const bundles = cloudCatalogBundles(
			[{ ...summary(), activeSessionId: null }],
			{},
		);
		expect(bundles["cloud:workspace-1"]?.[0]?.sessions).toEqual([]);
		expect(
			bundles["cloud:workspace-1"]?.[0]?.chats[0]?.activeSessionId,
		).toBeNull();
	});
	test("adds a metadata shell for a new active thread without discarding cached siblings", () => {
		const initial = cloudCatalogBundles([summary()], {});
		const next = cloudCatalogBundles(
			[
				{
					...summary(),
					updatedAt: 5,
					activeSessionId: AgentSessionId.make("thread-2"),
				},
			],
			initial,
		);
		expect(
			next["cloud:workspace-1"]?.[0]?.sessions.map((row) => row.id),
		).toEqual(["session-1", "thread-2"]);
		expect(next["cloud:workspace-1"]?.[0]?.chats[0]?.activeSessionId).toBe(
			"thread-2",
		);
	});
	test("shows only authenticated providers and fails closed on auth status failure", async () => {
		await refreshCloudCatalog();
		expect(appAtomRegistry.get(cloudAuthenticatedProvidersAtom)).toEqual([
			"codex",
		]);
		api.auth.mockRejectedValueOnce(new Error("temporary auth error"));
		await refreshCloudCatalog();
		expect(appAtomRegistry.get(cloudAuthenticatedProvidersAtom)).toEqual([]);
		expect(appAtomRegistry.get(cloudCatalogAtom).chats).toHaveLength(1);
	});
});
