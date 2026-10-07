import type { CloudAccountImage } from "@zuse/contracts";
import { beforeEach, expect, it, vi } from "vitest";

vi.mock("../../src/lib/cloud-workspace-session-cache.ts", () => ({
	hasCloudEntitlement: vi.fn(() => true),
	loadCloudEntitlements: vi.fn(async () => ({})),
	loadCloudProviders: vi.fn(async () => ({
		providers: [
			{ providerId: "boxd", displayName: "Box" },
			{ providerId: "e2b", displayName: "E2B" },
		],
	})),
	loadCloudImage: vi.fn(),
}));
const { hasCloudEntitlement, loadCloudImage, loadCloudProviders } =
	await import("../../src/lib/cloud-workspace-session-cache.ts");
const { refreshCloudImages, resetCloudImageMonitor, subscribeCloudImages } =
	await import("../../src/lib/cloud-image-monitor.ts");
const { requestCloudSettingsLeave } = await import(
	"../../src/lib/cloud-settings-guard.ts"
);

const image = (
	providerId: string,
	state: CloudAccountImage["state"],
): CloudAccountImage => ({
	providerId,
	state,
	repositories: [],
	providers: [],
	builds: [],
	updatedAt: 1,
});
beforeEach(() => {
	resetCloudImageMonitor();
	vi.clearAllMocks();
});

it("refreshes the default and every provider through completion and failure", async () => {
	let state: CloudAccountImage["state"] = "building";
	vi.mocked(loadCloudImage).mockImplementation(async (providerId) =>
		image(providerId ?? "boxd", state),
	);
	expect((await refreshCloudImages()).map((item) => item.state)).toEqual([
		"building",
		"building",
	]);
	state = "ready";
	expect((await refreshCloudImages()).map((item) => item.state)).toEqual([
		"ready",
		"ready",
	]);
	state = "failed";
	expect((await refreshCloudImages()).map((item) => item.state)).toEqual([
		"failed",
		"failed",
	]);
	expect(loadCloudImage).toHaveBeenCalledWith(undefined, true);
	expect(loadCloudImage).toHaveBeenCalledWith("boxd", true);
	expect(loadCloudImage).toHaveBeenCalledWith("e2b", true);
});

it("retains the last known progress when a provider cannot be reached", async () => {
	vi.mocked(loadCloudImage).mockImplementation(async (providerId) =>
		image(providerId ?? "boxd", "building"),
	);
	await refreshCloudImages();
	vi.mocked(loadCloudImage).mockImplementation(async (providerId) => {
		if (providerId === "e2b") throw new Error("offline");
		return image("boxd", "ready");
	});
	let snapshot: readonly CloudAccountImage[] = [];
	const unsubscribe = subscribeCloudImages((images) => {
		snapshot = images;
	});
	await expect(refreshCloudImages()).rejects.toThrow("could not be refreshed");
	expect(snapshot.map((item) => item.state)).toEqual(["ready", "building"]);
	unsubscribe();
});

it("discards an old account's in-flight response after reset", async () => {
	let finish!: () => void;
	const pending = new Promise<void>((resolve) => {
		finish = resolve;
	});
	vi.mocked(loadCloudImage).mockImplementation(async (providerId) => {
		await pending;
		return image(providerId ?? "boxd", "outdated");
	});
	const request = refreshCloudImages();
	await vi.waitFor(() => expect(loadCloudImage).toHaveBeenCalled());
	resetCloudImageMonitor();
	finish();
	expect(await request).toEqual([]);
	expect(requestCloudSettingsLeave()).toBe(true);
});

it("discovers a newly added provider and marks its missing image for rebuilding", async () => {
	vi.mocked(loadCloudImage).mockImplementation(async (providerId) =>
		image(providerId ?? "boxd", "ready"),
	);
	await refreshCloudImages();
	vi.mocked(loadCloudProviders).mockResolvedValueOnce({
		providers: [
			{ providerId: "boxd", displayName: "Box" },
			{ providerId: "e2b", displayName: "E2B" },
			{ providerId: "new", displayName: "New provider" },
		],
	});
	vi.mocked(loadCloudImage).mockImplementation(async (providerId) =>
		image(providerId ?? "boxd", providerId === "new" ? "not-built" : "ready"),
	);
	expect(
		(await refreshCloudImages()).find((item) => item.providerId === "new")
			?.state,
	).toBe("not-built");
	expect(loadCloudProviders).toHaveBeenLastCalledWith(true);
	// Another provider's image is ready, so leaving Settings is not blocked.
	const confirm = vi.fn(() => false);
	vi.stubGlobal("window", { confirm });
	try {
		expect(requestCloudSettingsLeave()).toBe(true);
		expect(confirm).not.toHaveBeenCalled();
	} finally {
		vi.unstubAllGlobals();
	}
});

it("asks before leaving Settings only when no image is ready", async () => {
	vi.mocked(loadCloudImage).mockImplementation(async (providerId) =>
		image(
			providerId ?? "boxd",
			providerId === "e2b" ? "not-built" : "outdated",
		),
	);
	await refreshCloudImages();
	const confirm = vi.fn(() => false);
	vi.stubGlobal("window", { confirm });
	try {
		expect(requestCloudSettingsLeave()).toBe(false);
		expect(confirm).toHaveBeenCalledOnce();
	} finally {
		vi.unstubAllGlobals();
	}
});

it("treats provider-key eligibility as cloud access without a subscription", async () => {
	vi.mocked(hasCloudEntitlement).mockReturnValue(false);
	vi.mocked(loadCloudProviders).mockResolvedValueOnce({
		providers: [{ providerId: "boxd", displayName: "boxd" }],
		entitled: true,
	});
	vi.mocked(loadCloudImage).mockImplementation(async (providerId) =>
		image(providerId ?? "boxd", "ready"),
	);
	try {
		expect((await refreshCloudImages()).length).toBeGreaterThan(0);
	} finally {
		vi.mocked(hasCloudEntitlement).mockReturnValue(true);
	}
});
