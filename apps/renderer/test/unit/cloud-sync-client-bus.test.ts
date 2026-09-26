import { afterEach, beforeEach, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	configure: vi.fn(),
	prepare: vi.fn(),
	prefs: vi.fn(),
	request: vi.fn(),
	catalogListeners: [] as Array<() => void>,
	summaries: [] as Array<{ workspaceId: string; state: string }>,
}));
vi.mock("../../src/lib/bridge.ts", () => ({
	getAppBridge: () => ({
		cloudSyncConfigure: mocks.configure,
		cloudSyncDefaultPath: async () => "/local/repo",
		cloudSyncRequest: mocks.request,
	}),
}));
vi.mock("../../src/lib/cloud-ssh-client-bus.ts", () => ({
	prepareCloudWorkspaceSsh: mocks.prepare,
}));
vi.mock("../../src/lib/cloud-workspace-catalog.ts", () => ({
	cloudSummaryForEnvironment: () => ({
		repositoryDisplayName: "repo",
		branch: "main",
	}),
	cloudSyncPreferenceEnabled: () => true,
	cloudSyncPrefsFor: () => ({ enabled: true }),
	setCloudSyncPrefs: mocks.prefs,
	useCloudChatCatalogStore: {
		subscribe: (listener: () => void) => {
			mocks.catalogListeners.push(listener);
			return () => {};
		},
		getState: () => ({ summaries: mocks.summaries }),
	},
}));

import {
	disableCloudSync,
	enableCloudSync,
} from "../../src/lib/cloud-sync-client-bus.ts";

beforeEach(() => {
	vi.useFakeTimers();
	vi.clearAllMocks();
	mocks.prepare.mockResolvedValue({
		hostAlias: "zuse-workspace",
		remotePath: "/remote/repo",
	});
	mocks.configure.mockImplementation(async (input) => ({
		...input,
		state: input.enabled ? "pending" : "idle",
		lastSyncedAt: null,
		error: null,
		accessRefreshRequired: false,
	}));
});
afterEach(async () => {
	await disableCloudSync("workspace");
	vi.useRealTimers();
});
test("starts the desktop scanner without waiting for a filesystem watcher", async () => {
	await enableCloudSync("workspace");
	expect(mocks.configure).toHaveBeenCalledWith({
		workspaceId: "workspace",
		enabled: true,
		localPath: "/local/repo",
		hostAlias: "zuse-workspace",
		remotePath: "/remote/repo",
	});
	await enableCloudSync("workspace");
	expect(mocks.prepare).toHaveBeenCalledTimes(1);
});
test("disable interrupts a hung setup and late access cannot enable sync", async () => {
	let finish!: (value: unknown) => void;
	mocks.prepare.mockImplementationOnce(
		() =>
			new Promise((resolve) => {
				finish = resolve;
			}),
	);
	const start = enableCloudSync("workspace");
	await vi.advanceTimersByTimeAsync(0);
	await disableCloudSync("workspace");
	await start;
	finish({ hostAlias: "zuse-workspace", remotePath: "/remote/repo" });
	await vi.advanceTimersByTimeAsync(0);
	expect(mocks.configure.mock.calls.every(([input]) => !input.enabled)).toBe(
		true,
	);
});
test("access setup has a deadline and can be retried instead of staying pending", async () => {
	mocks.prepare.mockImplementationOnce(() => new Promise(() => {}));
	const start = enableCloudSync("workspace");
	await vi.advanceTimersByTimeAsync(30_001);
	await start;
	expect(mocks.configure).not.toHaveBeenCalled();
	await enableCloudSync("workspace");
	expect(mocks.configure).toHaveBeenCalledTimes(1);
});
test("desktop rejection does not leave an active worker blocking retries", async () => {
	mocks.configure.mockResolvedValueOnce(null);
	await enableCloudSync("workspace");
	await enableCloudSync("workspace");
	expect(mocks.configure).toHaveBeenCalledTimes(2);
});

test("ready transition during teardown starts the worker after teardown completes", async () => {
	vi.resetModules();
	vi.stubGlobal("window", {});
	mocks.summaries = [{ workspaceId: "workspace", state: "ready" }];
	const bus = await import("../../src/lib/cloud-sync-client-bus.ts");
	await vi.advanceTimersByTimeAsync(0);
	let finish!: () => void;
	mocks.configure.mockImplementationOnce(
		() =>
			new Promise((resolve) => {
				finish = () =>
					resolve({ workspaceId: "workspace", enabled: false, state: "idle" });
			}),
	);
	mocks.summaries = [{ workspaceId: "workspace", state: "paused" }];
	for (const listener of mocks.catalogListeners) listener();
	// Reconnect before the queued stop even enters its body.
	mocks.summaries = [{ workspaceId: "workspace", state: "ready" }];
	for (const listener of mocks.catalogListeners) listener();
	await vi.advanceTimersByTimeAsync(0);
	finish();
	await vi.advanceTimersByTimeAsync(0);
	expect(
		mocks.configure.mock.calls.filter(([input]) => input.enabled),
	).toHaveLength(2);
	mocks.summaries = [];
	await bus.disableCloudSync("workspace");
	vi.unstubAllGlobals();
});
