import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as settleIO } from "node:timers/promises";
import { expect, test, vi } from "vitest";
import { CloudSyncManager } from "../../src/sync/cloud-sync-service.ts";
import type { SyncFile } from "../../src/sync/cloud-sync-snapshot.ts";

const advance = async (ms: number) => {
	await vi.advanceTimersByTimeAsync(ms);
	await settleIO(15);
};
async function withManager(
	run: (
		manager: CloudSyncManager,
		config: Parameters<CloudSyncManager["configure"]>[0],
	) => Promise<void>,
	download: ConstructorParameters<typeof CloudSyncManager>[1],
	apply: ConstructorParameters<typeof CloudSyncManager>[2] = async () => {},
) {
	vi.useFakeTimers();
	const localPath = await mkdtemp(join(tmpdir(), "zuse-snapshots-"));
	const manager = new CloudSyncManager(() => {}, download, apply);
	const config = {
		workspaceId: "batch",
		enabled: true,
		localPath,
		hostAlias: "zuse-batch",
		remotePath: "/repo",
	};
	try {
		await manager.configure(config);
		await run(manager, config);
	} finally {
		await manager.dispose();
		await rm(localPath, { recursive: true, force: true });
		await rm(`${localPath}.zuse-sync-cache`, { recursive: true, force: true });
		vi.useRealTimers();
	}
}

test("initial scan starts immediately and continuous hints cannot starve batches", async () => {
	const download = vi.fn(async () => []);
	await withManager(async (manager) => {
		await advance(0);
		await vi.waitFor(() =>
			expect(manager.status("batch").state).toBe("in-sync"),
		);
		expect(download).toHaveBeenCalledTimes(1);
		for (let i = 0; i < 20; i++) {
			manager.requestSync("batch");
			await advance(1_000);
		}
		expect(download).toHaveBeenCalledTimes(2);
	}, download);
});

test("changes during a scan do not discard completed data or overlap scans", async () => {
	let finish!: (files: SyncFile[]) => void;
	const download = vi.fn(
		() =>
			new Promise<SyncFile[]>((resolve) => {
				finish = resolve;
			}),
	);
	const apply = vi.fn(async () => {});
	await withManager(
		async (manager) => {
			await advance(0);
			await vi.waitFor(() => expect(download).toHaveBeenCalledTimes(1));
			for (let i = 0; i < 10; i++) {
				manager.requestSync("batch");
				await advance(5_000);
			}
			expect(download).toHaveBeenCalledTimes(1);
			finish([]);
			await settleIO(20);
			expect(apply).toHaveBeenCalledTimes(1);
			expect(manager.status("batch").state).toBe("in-sync");
			await advance(14_999);
			expect(download).toHaveBeenCalledTimes(1);
		},
		download,
		apply,
	);
});

test("periodic scanning repairs missed watcher signals", async () => {
	const download = vi.fn(async () => []);
	await withManager(async (manager) => {
		await advance(0);
		await vi.waitFor(() =>
			expect(manager.status("batch").state).toBe("in-sync"),
		);
		await advance(30_000);
		await vi.waitFor(() => expect(download).toHaveBeenCalledTimes(2));
	}, download);
});

test("failed scans retain the last good state and event storms cannot bypass backoff", async () => {
	const download = vi.fn(async (): Promise<SyncFile[]> => {
		throw new Error("connection closed");
	});
	const apply = vi.fn(async () => {});
	await withManager(
		async (manager) => {
			await advance(0);
			await vi.waitFor(() =>
				expect(manager.status("batch").state).toBe("error"),
			);
			expect(manager.status("batch").accessRefreshRequired).toBe(true);
			for (let i = 0; i < 10; i++) {
				manager.requestSync("batch");
				await advance(1_000);
			}
			expect(download).toHaveBeenCalledTimes(1);
			expect(apply).not.toHaveBeenCalled();
			await advance(5_000);
			await vi.waitFor(() => expect(download).toHaveBeenCalledTimes(2));
		},
		download,
		apply,
	);
});

test("disable cancels and joins the scan before reconfiguration", async () => {
	const apply = vi.fn(async () => {});
	const download = vi.fn(
		async (
			_config,
			_staging,
			_baseline,
			signal: AbortSignal,
		): Promise<SyncFile[]> =>
			new Promise((resolve) =>
				signal.addEventListener("abort", () => resolve([]), { once: true }),
			),
	);
	await withManager(
		async (manager, config) => {
			await advance(0);
			await vi.waitFor(() => expect(download).toHaveBeenCalledTimes(1));
			await manager.configure({ ...config, enabled: false });
			expect(manager.status("batch").state).toBe("idle");
			expect(apply).not.toHaveBeenCalled();
			await manager.configure(config);
			await advance(10_000);
			expect(download).toHaveBeenCalledTimes(1);
		},
		download,
		apply,
	);
});
