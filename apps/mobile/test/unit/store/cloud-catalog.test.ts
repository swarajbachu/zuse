import { AgentSessionId } from "@zuse/contracts";
import { Effect } from "effect";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { summary, workspace } from "../../fixtures/cloud";

const api = vi.hoisted(() => ({ list: vi.fn(), auth: vi.fn() }));
vi.mock("~/rpc/api-client", () => ({
	cloudControlClient: {
		"cloud.chats.list": () => Effect.promise(api.list),
		"cloud.projects.list": () => Effect.succeed({ projects: [] }),
		"cloud.auth.status": () => Effect.tryPromise(api.auth),
		"cloud.image.status": () => Effect.succeed(null),
	},
}));

import { availableConnections } from "../../../src/lib/connection-records";
import {
	cloudAuthenticatedProvidersAtom,
	cloudCatalogAtom,
	cloudCatalogBundles,
	cloudConnectionsAtom,
	refreshCloudCatalog,
	registerCloudSummary,
	setCloudCatalogAccount,
} from "../../../src/store/cloud-catalog";
import { appAtomRegistry } from "../../../src/store/registry";

describe("account-owned mobile cloud catalog", () => {
	beforeEach(() => {
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
