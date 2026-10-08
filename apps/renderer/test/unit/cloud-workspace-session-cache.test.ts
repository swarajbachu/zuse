import { Effect } from "effect";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

vi.mock("../../src/lib/rpc-client.ts", () => ({
	getControlPlaneRpcClient: vi.fn(),
}));
const { getControlPlaneRpcClient } = await import(
	"../../src/lib/rpc-client.ts"
);
const { clearControlPlaneSessionCache } = await import(
	"../../src/lib/control-plane-client.ts"
);
const {
	loadCloudWorkspacePlacement,
	loadCloudImage,
	loadCloudEntitlements,
	loadCloudGithub,
} = await import("../../src/lib/cloud-workspace-session-cache.ts");

beforeEach(() => {
	clearControlPlaneSessionCache();
	vi.useFakeTimers();
});
afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllGlobals();
});

it("loads funded organization placement without requesting private billing records", async () => {
	const entitlements = vi.fn(() => Effect.fail({ code: "not-allowed" }));
	vi.mocked(getControlPlaneRpcClient).mockResolvedValue({
		"cloud.providers": () => Effect.succeed({ providers: [], entitled: true }),
		"cloud.projects.list": () => Effect.succeed({ projects: [] }),
		"machines.entitlements": entitlements,
	} as unknown as Awaited<ReturnType<typeof getControlPlaneRpcClient>>);
	await expect(loadCloudWorkspacePlacement()).resolves.toMatchObject({
		subscribed: true,
	});
	expect(entitlements).not.toHaveBeenCalled();
});

it("refreshes GitHub connection state after webhook changes instead of caching it indefinitely", async () => {
	let configured = false;
	const status = vi.fn(() =>
		Effect.succeed({ configured, installations: [], repositories: [] }),
	);
	vi.mocked(getControlPlaneRpcClient).mockResolvedValue({
		"cloud.github.status": status,
	} as unknown as Awaited<ReturnType<typeof getControlPlaneRpcClient>>);
	expect((await loadCloudGithub()).configured).toBe(false);
	configured = true;
	await loadCloudGithub();
	expect(status).toHaveBeenCalledTimes(1);
	await vi.advanceTimersByTimeAsync(30_001);
	await loadCloudGithub();
	await vi.waitFor(() => expect(status).toHaveBeenCalledTimes(2));
	expect((await loadCloudGithub()).configured).toBe(true);
});

it("rechecks a previously unsubscribed workspace after checkout instead of caching it for the app session", async () => {
	let paid = false;
	const entitlements = vi.fn(() =>
		Effect.succeed({
			entitlements: paid ? [{ kind: "cloud-workspace", status: "active" }] : [],
		}),
	);
	vi.mocked(getControlPlaneRpcClient).mockResolvedValue({
		"machines.entitlements": entitlements,
	} as unknown as Awaited<ReturnType<typeof getControlPlaneRpcClient>>);
	expect((await loadCloudEntitlements()).entitlements).toEqual([]);
	paid = true;
	await vi.advanceTimersByTimeAsync(30_001);
	expect((await loadCloudEntitlements()).entitlements[0]?.status).toBe(
		"active",
	);
	expect(entitlements).toHaveBeenCalledTimes(2);
});

it("keeps placement visible while refreshing stale display data in the background", async () => {
	let slow = false;
	let resolveImage!: (value: unknown) => void;
	const pendingImage = new Promise((resolve) => {
		resolveImage = resolve;
	});
	const image = { providerId: "box", state: "ready", repositories: [] };
	const imageStatus = vi.fn(() =>
		slow ? Effect.promise(() => pendingImage) : Effect.succeed(image),
	);
	const entitlements = vi.fn(() =>
		Effect.succeed({
			entitlements: [{ kind: "cloud-workspace", status: "active" }],
		}),
	);
	vi.mocked(getControlPlaneRpcClient).mockResolvedValue({
		"cloud.providers": () =>
			Effect.succeed({ providers: [{ providerId: "box" }] }),
		"cloud.projects.list": () => Effect.succeed({ projects: [] }),
		"cloud.image.status": imageStatus,
		"machines.entitlements": entitlements,
	} as unknown as Awaited<ReturnType<typeof getControlPlaneRpcClient>>);

	expect((await loadCloudWorkspacePlacement()).subscribed).toBe(true);
	slow = true;
	await vi.advanceTimersByTimeAsync(7 * 24 * 60 * 60 * 1_000);
	const placement = await loadCloudWorkspacePlacement();
	expect(placement.subscribed).toBe(true);
	expect(placement.images).toEqual([image]);
	// Display data stays visible; subscription eligibility is revalidated.
	expect(await loadCloudImage("box")).toEqual(image);
	expect((await loadCloudEntitlements()).entitlements[0]?.status).toBe(
		"active",
	);
	await vi.waitFor(() => expect(imageStatus).toHaveBeenCalledTimes(2));
	expect(entitlements).toHaveBeenCalledTimes(2);
	const refreshed = loadCloudImage("box", true);
	expect(await loadCloudImage("box")).toEqual(image);
	resolveImage({ ...image, state: "outdated" });
	await refreshed;
	expect((await loadCloudWorkspacePlacement()).images[0]?.state).toBe(
		"outdated",
	);
});

it("restores provider display state locally and replaces it after disconnect", async () => {
	const storage = new Map<string, string>();
	vi.stubGlobal("window", {
		localStorage: {
			getItem: (key: string) => storage.get(key) ?? null,
			setItem: (key: string, value: string) => storage.set(key, value),
			removeItem: (key: string) => storage.delete(key),
		},
	});
	const { setControlPlaneCacheAccount } = await import(
		"../../src/lib/control-plane-client.ts"
	);
	const { cacheCloudProviderConnections, peekCloudProviderConnections } =
		await import("../../src/lib/cloud-workspace-session-cache.ts");
	setControlPlaneCacheAccount("cached-hosting-account");
	const connected = {
		connections: [
			{ connectionId: "key", providerId: "boxd", active: true, createdAt: 1 },
		],
		customSnapshotsEnabled: true,
	};
	await cacheCloudProviderConnections(connected);
	clearControlPlaneSessionCache();
	expect(peekCloudProviderConnections()).toMatchObject(connected);
	await cacheCloudProviderConnections({
		connections: [],
		customSnapshotsEnabled: true,
	});
	clearControlPlaneSessionCache();
	expect(peekCloudProviderConnections()?.connections).toEqual([]);
	setControlPlaneCacheAccount("another-hosting-account");
	expect(peekCloudProviderConnections()).toBeUndefined();
	setControlPlaneCacheAccount(null);
});
it("restores a last known billing display while a refresh is pending", async () => {
	const storage = new Map<string, string>();
	vi.stubGlobal("window", {
		localStorage: {
			getItem: (key: string) => storage.get(key) ?? null,
			setItem: (key: string, value: string) => storage.set(key, value),
			removeItem: (key: string) => storage.delete(key),
		},
	});
	const { setControlPlaneCacheAccount } = await import(
		"../../src/lib/control-plane-client.ts"
	);
	const { peekCloudEntitlements } = await import(
		"../../src/lib/cloud-workspace-session-cache.ts"
	);
	setControlPlaneCacheAccount("billing-display-account");
	vi.mocked(getControlPlaneRpcClient).mockResolvedValue({
		"machines.entitlements": () => Effect.succeed({ entitlements: [] }),
	} as unknown as Awaited<ReturnType<typeof getControlPlaneRpcClient>>);
	await loadCloudEntitlements();
	clearControlPlaneSessionCache();
	expect(peekCloudEntitlements()).toEqual({ entitlements: [] });
	setControlPlaneCacheAccount(null);
});
