import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { withSystemTest } from "../../src/system-scope.ts";

describe("performance diagnostics artifacts", () => {
	it("includes bounded local performance history in the support bundle", async () => {
		await withSystemTest("zuse-performance-diagnostics-", async (scope) => {
			const logs = scope.path("user-data", "logs");
			mkdirSync(logs, { recursive: true });
			writeFileSync(
				scope.path("user-data", "logs", "diagnostics.host-resources.ndjson"),
				`${JSON.stringify({
					kind: "sample",
					sample: {
						capturedAt: "2026-07-31T00:00:00.000Z",
						totalCpuPercent: 12.5,
						totalMemoryBytes: 1024,
					},
				})}\n`,
			);
			const server = await scope.server();
			const rpc = await scope.rpc(server.endpoint);
			const exported = await Effect.runPromise(
				rpc.client["diagnostics.export"]({
					since: "2026-07-30T00:00:00.000Z",
				}),
			);
			const zip = readFileSync(exported.bundlePath);

			expect(exported.included).toContain("performance-history");
			expect(zip.includes(Buffer.from("performance-history.json"))).toBe(true);
			expect(zip.includes(Buffer.from('"totalCpuPercent": 12.5'))).toBe(true);
			await rpc.dispose();
		});
	}, 30_000);
});
