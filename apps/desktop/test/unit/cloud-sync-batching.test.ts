import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as settleIO } from "node:timers/promises";
import { expect, test, vi } from "vitest";
import { CloudSyncManager } from "../../src/sync/cloud-sync-service.ts";

test("continuous editing never launches an automatic batch", async () => {
	vi.useFakeTimers();
	const localPath = await mkdtemp(join(tmpdir(), "zuse-batching-"));
	const download = vi.fn(async () => ({ code: 0, stderr: "" }));
	const manager = new CloudSyncManager(() => {}, download);
	try {
		await manager.configure({
			workspaceId: "batching",
			enabled: true,
			localPath,
			hostAlias: "zuse-batching",
			remotePath: "/workspace",
		});
		for (let i = 0; i < 40; i++) {
			manager.requestSync("batching");
			await vi.advanceTimersByTimeAsync(2_000);
			await settleIO(5);
		}
		expect(download).not.toHaveBeenCalled();
	} finally {
		await manager.dispose();
		await rm(localPath, { recursive: true, force: true });
		vi.useRealTimers();
	}
});

const ok = { code: 0, stderr: "" };
const deferred = () => {
	let resolve!: (value: typeof ok) => void;
	const promise = new Promise<typeof ok>((done) => {
		resolve = done;
	});
	return { promise, resolve };
};

const withManager = async (
	run: (
		manager: CloudSyncManager,
		config: Parameters<CloudSyncManager["configure"]>[0],
	) => Promise<void>,
	download: NonNullable<
		ConstructorParameters<typeof CloudSyncManager>[1]
	> = async () => ok,
	apply: NonNullable<
		ConstructorParameters<typeof CloudSyncManager>[3]
	> = async () => ok,
) => {
	vi.useFakeTimers();
	const localPath = await mkdtemp(join(tmpdir(), "zuse-batch-"));
	const manager = new CloudSyncManager(() => {}, download, undefined, apply);
	const config = {
		workspaceId: "batch",
		enabled: true,
		localPath,
		hostAlias: "zuse-batch",
		remotePath: "/workspace",
	};
	try {
		await manager.configure(config);
		await run(manager, config);
	} finally {
		await manager.dispose();
		await rm(localPath, { recursive: true, force: true });
		vi.useRealTimers();
	}
};

const advance = async (ms: number) => {
	await vi.advanceTimersByTimeAsync(ms);
	await settleIO(20);
};

test("thousands of events coalesce into one settled batch", async () => {
	const download = vi.fn(async () => ok);
	const apply = vi.fn(async () => ok);
	await withManager(
		async (manager) => {
			for (let i = 0; i < 3_000; i++) manager.requestSync("batch");
			await advance(4_999);
			expect(download.mock.calls.length).toBe(0);
			await advance(1);
			await vi.waitFor(() =>
				expect(manager.status("batch").state).toBe("in-sync"),
			);
			expect(download.mock.calls.length).toBe(1);
			expect(apply.mock.calls.length).toBe(1);
		},
		download,
		apply,
	);
});

test("a download racing changes is not applied and staging is reused", async () => {
	const first = deferred();
	const destinations: string[] = [];
	const download = vi.fn(
		async (
			...args: Parameters<
				ConstructorParameters<typeof CloudSyncManager>[1] & {}
			>
		) => {
			destinations.push(args[0].at(-1) ?? "");
			return destinations.length === 1 ? first.promise : ok;
		},
	);
	const apply = vi.fn(async () => ok);
	await withManager(
		async (manager) => {
			await advance(5_000);
			await vi.waitFor(() => expect(download.mock.calls.length).toBe(1));
			manager.requestSync("batch");
			first.resolve(ok);
			await advance(0);
			expect(manager.status("batch").state).toBe("pending");
			expect(apply.mock.calls.length).toBe(0);
			await advance(4_999);
			expect(download.mock.calls.length).toBe(1);
			await advance(1);
			await vi.waitFor(() => expect(apply.mock.calls.length).toBe(1));
			expect(destinations[0]).toBe(destinations[1]);
		},
		download,
		apply,
	);
});

test("changes during apply wait for completion and the full cooldown", async () => {
	const first = deferred();
	const download = vi.fn(async () => ok);
	const apply = vi.fn(async () =>
		apply.mock.calls.length === 1 ? first.promise : ok,
	);
	await withManager(
		async (manager) => {
			await advance(5_000);
			await vi.waitFor(() => expect(apply.mock.calls.length).toBe(1));
			manager.requestSync("batch");
			await advance(20_000);
			expect(download.mock.calls.length).toBe(1);
			first.resolve(ok);
			await advance(0);
			expect(manager.status("batch").state).toBe("pending");
			await advance(14_999);
			expect(download.mock.calls.length).toBe(1);
			await advance(1);
			await vi.waitFor(() => expect(download.mock.calls.length).toBe(2));
		},
		download,
		apply,
	);
});

test("filesystem events cannot bypass retry backoff", async () => {
	const download = vi.fn(async () => ({
		code: 12,
		stderr: "network unavailable",
	}));
	await withManager(async (manager) => {
		await advance(5_000);
		await vi.waitFor(() => expect(manager.status("batch").state).toBe("error"));
		await advance(5_000);
		await vi.waitFor(() => expect(download.mock.calls.length).toBe(2));
		await advance(0);
		manager.requestSync("batch");
		await advance(5_000);
		expect(download.mock.calls.length).toBe(2);
		await advance(5_000);
		await vi.waitFor(() => expect(download.mock.calls.length).toBe(3));
	}, download);
});

test("periodic reconciliation waits for quiet and performs one batch", async () => {
	const download = vi.fn(async () => ok);
	await withManager(async (manager) => {
		await advance(5_000);
		await vi.waitFor(() =>
			expect(manager.status("batch").state).toBe("in-sync"),
		);
		await advance(60_000);
		expect(manager.status("batch").state).toBe("pending");
		expect(download.mock.calls.length).toBe(1);
		await advance(4_000);
		manager.requestSync("batch");
		await advance(4_999);
		expect(download.mock.calls.length).toBe(1);
		await advance(1);
		await vi.waitFor(() => expect(download.mock.calls.length).toBe(2));
	}, download);
});

test("reconfiguration waits for cancelled downloads and never applies their data", async () => {
	const first = deferred();
	let signal: AbortSignal | undefined;
	const download = vi.fn(
		async (_args: ReadonlyArray<string>, current?: AbortSignal) => {
			signal = current;
			return download.mock.calls.length === 1 ? first.promise : ok;
		},
	);
	const apply = vi.fn(async () => ok);
	await withManager(
		async (manager, config) => {
			await advance(5_000);
			await vi.waitFor(() => expect(download.mock.calls.length).toBe(1));
			const disable = manager.configure({ ...config, enabled: false });
			const reconnect = manager.configure(config);
			await advance(0);
			expect(signal?.aborted).toBe(true);
			expect(download.mock.calls.length).toBe(1);
			first.resolve(ok);
			await disable;
			await reconnect;
			expect(apply.mock.calls.length).toBe(0);
			await advance(5_000);
			await vi.waitFor(() => expect(apply.mock.calls.length).toBe(1));
		},
		download,
		apply,
	);
});

test("reconfiguration waits until an aborted apply has actually stopped", async () => {
	const first = deferred();
	const download = vi.fn(async () => ok);
	let applySignal: AbortSignal | undefined;
	const apply = vi.fn(
		async (_args: ReadonlyArray<string>, signal?: AbortSignal) => {
			applySignal = signal;
			return apply.mock.calls.length === 1 ? first.promise : ok;
		},
	);
	await withManager(
		async (manager, config) => {
			await advance(5_000);
			await vi.waitFor(() => expect(apply.mock.calls.length).toBe(1));
			const reconfigure = manager.configure(config);
			await advance(20_000);
			expect(applySignal?.aborted).toBe(true);
			expect(download.mock.calls.length).toBe(1);
			first.resolve(ok);
			await reconfigure;
			await advance(14_999);
			expect(download.mock.calls.length).toBe(1);
			await advance(1);
			await vi.waitFor(() => expect(apply.mock.calls.length).toBe(2));
		},
		download,
		apply,
	);
});

test("an apply failure remains pending for retry and honors the batch cooldown", async () => {
	const download = vi.fn(async () => ok);
	const apply = vi.fn(async () => ({
		code: 23,
		stderr: "cannot write destination",
	}));
	await withManager(
		async (manager) => {
			await advance(5_000);
			await vi.waitFor(() =>
				expect(manager.status("batch").state).toBe("error"),
			);
			expect(manager.status("batch").lastSyncedAt).toBeNull();
			manager.requestSync("batch");
			await advance(10_000);
			expect(download.mock.calls.length).toBe(1);
			await advance(5_000);
			await vi.waitFor(() => expect(apply.mock.calls.length).toBe(2));
		},
		download,
		apply,
	);
});

test("disconnect and reconnect preserve the previous batch cooldown", async () => {
	const download = vi.fn(async () => ok);
	await withManager(async (manager, config) => {
		await advance(5_000);
		await vi.waitFor(() =>
			expect(manager.status("batch").state).toBe("in-sync"),
		);
		await manager.configure({ ...config, enabled: false });
		manager.requestSync("batch");
		expect(manager.status("batch").state).toBe("idle");
		await manager.configure(config);
		await advance(10_000);
		expect(download.mock.calls.length).toBe(1);
		await advance(5_000);
		await vi.waitFor(() => expect(download.mock.calls.length).toBe(2));
	}, download);
});
