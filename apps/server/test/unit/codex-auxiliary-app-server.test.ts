import { afterEach, describe, expect, it, vi } from "vitest";

import {
	type CodexAuxiliaryConnection,
	createCodexAuxiliaryAppServerPool,
} from "../../src/codex/auxiliary-app-server.ts";

const connection = () => {
	const request = vi.fn(async (_method: unknown, _params: unknown) => ({
		ok: true,
	}));
	const app: CodexAuxiliaryConnection = {
		isClosed: false,
		request: async <T>(
			method: Parameters<CodexAuxiliaryConnection["request"]>[0],
			params: unknown,
		) => (await request(method, params)) as T,
		close: vi.fn(),
	};
	return { app, request };
};

describe("Codex auxiliary app-server pool", () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	it("coalesces concurrent feature reads into one app-server process", async () => {
		const { app, request } = connection();
		const start = vi.fn(async () => app);
		const pool = createCodexAuxiliaryAppServerPool({
			start,
			idleTimeoutMs: 30_000,
		});

		await Promise.all(
			Array.from({ length: 10 }, () =>
				pool.withClient({ codexPath: "codex" }, (client) =>
					client.request("account/read", {}),
				),
			),
		);

		expect(start).toHaveBeenCalledTimes(1);
		expect(request).toHaveBeenCalledTimes(10);
		expect(app.close).not.toHaveBeenCalled();
		await pool.shutdown();
	});

	it("reuses an idle process and closes it after the idle window", async () => {
		vi.useFakeTimers();
		const { app } = connection();
		const start = vi.fn(async () => app);
		const pool = createCodexAuxiliaryAppServerPool({
			start,
			idleTimeoutMs: 1_000,
		});

		await pool.withClient({ codexPath: "codex" }, async () => "first");
		await pool.withClient({ codexPath: "/usr/local/bin/codex" }, async () => [
			"second",
		]);

		expect(start).toHaveBeenCalledTimes(1);
		await vi.advanceTimersByTimeAsync(999);
		expect(app.close).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(1);
		expect(app.close).toHaveBeenCalledTimes(1);
	});

	it("retries startup after a failed shared initialization", async () => {
		const { app } = connection();
		const start = vi
			.fn()
			.mockRejectedValueOnce(new Error("startup failed"))
			.mockResolvedValueOnce(app);
		const pool = createCodexAuxiliaryAppServerPool({
			start,
			idleTimeoutMs: 30_000,
		});

		await expect(
			pool.withClient({ codexPath: "codex" }, async () => "never"),
		).rejects.toThrow("startup failed");
		await expect(
			pool.withClient({ codexPath: "codex" }, async () => "recovered"),
		).resolves.toBe("recovered");
		expect(start).toHaveBeenCalledTimes(2);
		await pool.shutdown();
	});
});
