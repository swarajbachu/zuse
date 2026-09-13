import { Effect, Queue, Stream } from "effect";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

const app = vi.hoisted(() => ({
	cloudSyncConfigure: vi.fn(async () => null),
	cloudSyncRequest: vi.fn(async () => {}),
	cloudSyncDefaultPath: vi.fn(async () => "/local/workspace"),
}));
vi.mock("../../src/lib/bridge.ts", () => ({ getAppBridge: () => app }));
vi.mock("../../src/lib/cloud-ssh-client-bus.ts", () => ({
	prepareCloudWorkspaceSsh: async () => ({
		hostAlias: "zuse-workspace",
		remotePath: "/remote/workspace",
	}),
}));
vi.mock("../../src/store/environment-catalog.ts", () => ({
	useEnvironmentCatalogStore: {
		subscribe: () => {},
		getState: () => ({ entries: [] }),
	},
}));
vi.mock("../../src/lib/cloud-workspace-catalog.ts", () => ({
	cloudSummaryForEnvironment: () => ({
		repositoryDisplayName: "repo",
		branch: "main",
	}),
	cloudSyncPreferenceEnabled: () => true,
	cloudSyncPrefsFor: () => ({ enabled: true }),
	setCloudSyncPrefs: () => {},
	useCloudChatCatalogStore: {
		subscribe: () => {},
		getState: () => ({ summaries: [] }),
	},
}));
let queue: Queue.Queue<{ _tag: "ready" | "changed" }>;
let watcherFailed = false;
const subscribed = vi.fn();
vi.mock("../../src/lib/session-timeline-client-bus.ts", () => ({
	getRendererClientBus: () => ({
		client: () => ({
			"workspace.list": () => Effect.succeed([{ id: "folder" }]),
			"fs.watchTree": () => {
				subscribed();
				return watcherFailed
					? Stream.fail(new Error("Disconnected"))
					: Stream.fromQueue(queue);
			},
		}),
	}),
}));

import {
	disableCloudSync,
	enableCloudSync,
} from "../../src/lib/cloud-sync-client-bus.ts";

beforeEach(async () => {
	queue = await Effect.runPromise(Queue.unbounded());
	watcherFailed = false;
	vi.clearAllMocks();
});
afterEach(async () => {
	await disableCloudSync("workspace");
});

test("attaches the watcher before configuring the initial sync", async () => {
	const enabled = enableCloudSync("workspace");
	await vi.waitFor(() => expect(subscribed).toHaveBeenCalledOnce());
	expect(app.cloudSyncConfigure).not.toHaveBeenCalled();
	Queue.offerUnsafe(queue, { _tag: "ready" });
	await enabled;
	expect(app.cloudSyncConfigure).toHaveBeenCalledOnce();
	Queue.offerUnsafe(queue, { _tag: "changed" });
	await vi.waitFor(() =>
		expect(app.cloudSyncRequest).toHaveBeenCalledWith("workspace"),
	);
});

test("preserves changes arriving while the desktop is configuring", async () => {
	let finish!: () => void;
	app.cloudSyncConfigure.mockImplementationOnce(
		() =>
			new Promise<null>((resolve) => {
				finish = () => resolve(null);
			}),
	);
	const enabled = enableCloudSync("workspace");
	await vi.waitFor(() => expect(subscribed).toHaveBeenCalledOnce());
	Queue.offerUnsafe(queue, { _tag: "ready" });
	await vi.waitFor(() => expect(app.cloudSyncConfigure).toHaveBeenCalledOnce());
	Queue.offerUnsafe(queue, { _tag: "changed" });
	await new Promise((resolve) => setTimeout(resolve, 10));
	expect(app.cloudSyncRequest).not.toHaveBeenCalled();
	finish();
	await enabled;
	expect(app.cloudSyncRequest).toHaveBeenCalledWith("workspace");
});

test("watcher failure still enables periodic reconciliation without duplicate workers", async () => {
	watcherFailed = true;
	await enableCloudSync("workspace");
	await enableCloudSync("workspace");
	expect(app.cloudSyncConfigure).toHaveBeenCalledOnce();
});
