import { describe, expect, it, vi } from "vitest";

import { AcpResponseError, AcpRpcClient } from "../../src/rpc-client.js";

describe("AcpRpcClient", () => {
	it("correlates responses and releases settled requests", async () => {
		const sent: Array<unknown> = [];
		const client = new AcpRpcClient((message) => sent.push(message));
		const response = client.request("session/new", { cwd: "/repo" });

		expect(sent).toEqual([
			{
				jsonrpc: "2.0",
				id: 1,
				method: "session/new",
				params: { cwd: "/repo" },
			},
		]);
		expect(client.pendingCount).toBe(1);
		expect(
			client.acceptResponse({ jsonrpc: "2.0", id: 1, result: { id: "s1" } }),
		).toBe(true);
		await expect(response).resolves.toEqual({ id: "s1" });
		expect(client.pendingCount).toBe(0);
	});

	it("maps protocol failures with request context", async () => {
		const client = new AcpRpcClient(() => {});
		const response = client.request("initialize", {});
		client.acceptResponse({
			jsonrpc: "2.0",
			id: 1,
			error: { code: -32603, message: "broken", data: { retry: false } },
		});

		await expect(response).rejects.toEqual(
			new AcpResponseError(-32603, "initialize failed: broken", {
				retry: false,
			}),
		);
	});

	it("preserves a valid null result", async () => {
		const client = new AcpRpcClient(() => {});
		const response = client.request("session/cancel", {});
		client.acceptResponse({ jsonrpc: "2.0", id: 1, result: null });

		await expect(response).resolves.toBeNull();
	});

	it("cancels one request without retaining it", async () => {
		const client = new AcpRpcClient(() => {});
		let id = 0;
		const response = client.request(
			"session/prompt",
			{},
			{
				onAssignedId: (assigned) => {
					id = assigned;
				},
			},
		);

		expect(client.cancel(id, new Error("interrupted"))).toEqual({
			id,
			method: "session/prompt",
		});
		await expect(response).rejects.toThrow("interrupted");
		expect(client.pendingCount).toBe(0);
	});

	it("rejects and releases a request when the transport write fails", async () => {
		const client = new AcpRpcClient(() => {
			throw new Error("pipe closed");
		});
		const response = client.request("session/new", {});

		await expect(response).rejects.toThrow("pipe closed");
		expect(client.pendingCount).toBe(0);
	});

	it("times out and rejects all pending work deterministically", async () => {
		vi.useFakeTimers();
		try {
			const client = new AcpRpcClient(() => {});
			const timedOut = client.request("slow", {}, { timeoutMs: 25 });
			const rejected = client.request("other", {}, { timeoutMs: 1_000 });
			const timeoutAssertion = expect(timedOut).rejects.toThrow(
				"slow timed out after 25ms",
			);
			await vi.advanceTimersByTimeAsync(25);
			await timeoutAssertion;

			client.rejectAll(new Error("transport closed"));
			await expect(rejected).rejects.toThrow("transport closed");
			expect(client.pendingCount).toBe(0);
		} finally {
			vi.useRealTimers();
		}
	});
});
