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
const { loadCloudWorkspacePlacement, loadCloudImage, loadCloudEntitlements } =
	await import("../../src/lib/cloud-workspace-session-cache.ts");

beforeEach(() => {
	clearControlPlaneSessionCache();
	vi.useFakeTimers();
});
afterEach(() => vi.useRealTimers());

it("retains subscribed placement for the app session and refreshes only explicitly", async () => {
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
		slow
			? Effect.promise(() => new Promise(() => {}))
			: Effect.succeed({
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
	// Settings and New Chat reuse data without any timed network refresh.
	expect(await loadCloudImage("box")).toEqual(image);
	expect((await loadCloudEntitlements()).entitlements[0]?.status).toBe(
		"active",
	);
	expect(imageStatus).toHaveBeenCalledTimes(1);
	expect(entitlements).toHaveBeenCalledTimes(1);
	const refreshed = loadCloudImage("box", true);
	expect(await loadCloudImage("box")).toEqual(image);
	resolveImage({ ...image, state: "outdated" });
	await refreshed;
	expect((await loadCloudWorkspacePlacement()).images[0]?.state).toBe(
		"outdated",
	);
});
