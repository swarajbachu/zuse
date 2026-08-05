import { describe, expect, it, vi } from "vitest";

import { createConnectionRefreshCoordinator } from "../../../src/lib/connection-refresh-coordinator";

const deferred = () => {
	let resolve!: (authoritative: boolean) => void;
	const promise = new Promise<boolean>((done) => {
		resolve = done;
	});
	return { promise, resolve };
};

describe("connection refresh coordinator", () => {
	it("queues an authoritative refresh when a connection becomes ready", async () => {
		const first = deferred();
		const run = vi
			.fn<(key: string, options: { route: string }) => Promise<boolean>>()
			.mockReturnValueOnce(first.promise)
			.mockResolvedValueOnce(true);
		const coordinator = createConnectionRefreshCoordinator(run);

		const initial = coordinator.hydrate("connection-1", { route: "cached" });
		const connected = coordinator.refreshConnected(
			"connection-1",
			{ route: "live" },
			1,
		);
		expect(run).toHaveBeenCalledTimes(1);

		first.resolve(false);
		await Promise.all([initial, connected]);

		expect(run).toHaveBeenCalledTimes(2);
		expect(run).toHaveBeenLastCalledWith("connection-1", { route: "live" });
	});

	it("joins duplicate hydrations", async () => {
		const first = deferred();
		const run = vi.fn(() => first.promise);
		const coordinator = createConnectionRefreshCoordinator(run);

		const left = coordinator.hydrate("connection-1", { route: "same" });
		const right = coordinator.hydrate("connection-1", { route: "same" });

		expect(run).toHaveBeenCalledTimes(1);
		first.resolve(true);
		await Promise.all([left, right]);
	});

	it("does not duplicate a refresh that already became authoritative", async () => {
		const first = deferred();
		const run = vi.fn(() => first.promise);
		const coordinator = createConnectionRefreshCoordinator(run);

		const initial = coordinator.hydrate("connection-1", { route: "live" });
		const connected = coordinator.refreshConnected(
			"connection-1",
			{ route: "live" },
			1,
		);
		first.resolve(true);
		await Promise.all([initial, connected]);

		expect(run).toHaveBeenCalledTimes(1);
	});
});
