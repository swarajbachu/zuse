import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as settleIO } from "node:timers/promises";
import { Effect, Queue, Stream } from "effect";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { CloudSyncManager } from "../../../desktop/src/sync/cloud-sync-service.ts";

const app = vi.hoisted(() => ({
	cloudSyncConfigure: vi.fn(async () => null),
	cloudSyncRequest: vi.fn(async (_workspaceId: string) => {}),
	setCloudSyncPrefs: vi.fn(),
	cloudSyncPrefsFor: vi.fn<() => { enabled: boolean } | null>(() => ({
		enabled: true,
	})),
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
	cloudSyncPrefsFor: app.cloudSyncPrefsFor,
	setCloudSyncPrefs: app.setCloudSyncPrefs,
	useCloudChatCatalogStore: {
		subscribe: () => {},
		getState: () => ({ summaries: [] }),
	},
}));
let queue: Queue.Queue<
	{ _tag: "ready" | "gap" } | { _tag: "changed"; paths: string[] }
>;
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
	Queue.offerUnsafe(queue, { _tag: "changed", paths: ["src/index.ts"] });
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
	Queue.offerUnsafe(queue, { _tag: "changed", paths: ["src/index.ts"] });
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

test("disabling default-on sync persists an explicit opt-out", async () => {
	app.cloudSyncPrefsFor.mockReturnValueOnce(null);
	await disableCloudSync("workspace");
	expect(app.setCloudSyncPrefs).toHaveBeenCalledWith("workspace", {
		enabled: false,
	});
});

test("nested cache activity does not leave the local mirror waiting forever", async () => {
	const enabled = enableCloudSync("workspace");
	await vi.waitFor(() => expect(subscribed).toHaveBeenCalledOnce());
	Queue.offerUnsafe(queue, { _tag: "ready" });
	await enabled;
	const localPath = await mkdtemp(join(tmpdir(), "zuse-sync-noise-"));
	let finishDownload!: (result: { code: number; stderr: string }) => void;
	const download = vi.fn(
		() =>
			new Promise<{ code: number; stderr: string }>((resolve) => {
				finishDownload = resolve;
			}),
	);
	const apply = vi.fn(async () => ({ code: 0, stderr: "" }));
	const manager = new CloudSyncManager(() => {}, download, undefined, apply);
	vi.useFakeTimers();
	app.cloudSyncRequest.mockImplementation(async (workspaceId: string) => {
		manager.requestSync(workspaceId);
	});
	try {
		await manager.configure({
			workspaceId: "workspace",
			enabled: true,
			localPath,
			hostAlias: "zuse-workspace",
			remotePath: "/workspace",
		});
		for (let i = 0; i < 10; i++) {
			Queue.offerUnsafe(queue, {
				_tag: "changed",
				paths: ["apps/web/.next/cache/webpack/client.pack"],
			});
			await settleIO(10);
			await vi.advanceTimersByTimeAsync(2_000);
			await settleIO(20);
			if (i === 5) {
				expect(download).toHaveBeenCalledOnce();
				finishDownload({ code: 0, stderr: "" });
				await settleIO(20);
			}
		}
		expect(manager.status("workspace").state).toBe("in-sync");
		expect(apply).toHaveBeenCalledOnce();
	} finally {
		finishDownload?.({ code: 0, stderr: "" });
		app.cloudSyncRequest.mockImplementation(async () => {});
		await manager.dispose();
		vi.useRealTimers();
		await rm(localPath, { recursive: true, force: true });
	}
});

test("mixed changes and watcher gaps still request reconciliation", async () => {
	const enabled = enableCloudSync("workspace");
	await vi.waitFor(() => expect(subscribed).toHaveBeenCalledOnce());
	Queue.offerUnsafe(queue, { _tag: "ready" });
	await enabled;
	for (const event of [
		{ _tag: "changed", paths: ["apps/web/.turbo/build.log", "src/index.ts"] },
		{ _tag: "changed", paths: [] },
		{ _tag: "gap" },
	] as const) {
		Queue.offerUnsafe(
			queue,
			event._tag === "changed" ? { ...event, paths: [...event.paths] } : event,
		);
	}
	await vi.waitFor(() => expect(app.cloudSyncRequest).toHaveBeenCalledTimes(3));
});
