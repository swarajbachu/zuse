import { expect, test, vi } from "vitest";
import { CloudSyncFileBridge } from "../../src/sync/cloud-sync-file-bridge.ts";

test("correlates gateway replies and ignores a cancelled late response", async () => {
	const send = vi.fn();
	const bridge = new CloudSyncFileBridge(send);
	const abort = new AbortController();
	const first = bridge.read("one", "/tmp/part-0", abort.signal);
	const second = bridge.read(
		"two",
		"/tmp/part-1",
		new AbortController().signal,
	);
	const rejected = expect(first).rejects.toThrow("cancelled");
	abort.abort();
	await rejected;
	bridge.complete(send.mock.calls[0]?.[0].requestId, new Uint8Array([1]));
	bridge.complete(send.mock.calls[1]?.[0].requestId, new Uint8Array([2]));
	expect(await second).toEqual(new Uint8Array([2]));
});
test("bounds a missing renderer reply", async () => {
	vi.useFakeTimers();
	try {
		const bridge = new CloudSyncFileBridge(() => {});
		const result = bridge.read("w", "/tmp/part", new AbortController().signal);
		const rejected = expect(result).rejects.toThrow("timed out");
		await vi.advanceTimersByTimeAsync(30000);
		await rejected;
	} finally {
		vi.useRealTimers();
	}
});
