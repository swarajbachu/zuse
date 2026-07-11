import { describe, expect, it } from "vitest";
import {
	hasProductionDatabase,
	startHeadlessServer,
} from "../../src/headless-server.ts";

describe("headless server production composition", () => {
	it("boots on an operating-system assigned port and serves the real transport", async () => {
		const server = await startHeadlessServer();
		try {
			const response = await fetch(`http://127.0.0.1:${server.port}/`);
			expect(response.status).toBe(426);
			expect(await response.json()).toEqual({
				error: "wire_protocol_mismatch",
				expectedVersion: expect.any(Number),
			});
			expect(hasProductionDatabase(server)).toBe(true);
		} finally {
			await server.stop();
		}
	}, 30_000);

	it("rejects unauthenticated WebSocket upgrades in protected mode", async () => {
		const server = await startHeadlessServer({ host: "0.0.0.0" });
		try {
			const response = await fetch(
				`http://127.0.0.1:${server.port}/?wireVersion=1`,
			);
			expect(response.status).toBe(401);
			expect(await response.json()).toEqual({ error: "unauthorized" });
		} finally {
			await server.stop();
		}
	}, 30_000);
});
