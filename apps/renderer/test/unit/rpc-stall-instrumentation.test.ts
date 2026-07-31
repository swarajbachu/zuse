import { Effect } from "effect";
import { afterEach, describe, expect, test, vi } from "vitest";

import {
	instrumentRendererRpcClient,
	setRendererRpcLagReporter,
} from "../../src/lib/rpc-stall-instrumentation.ts";
import { getActiveStallOperations } from "../../src/lib/stall-context.ts";

afterEach(() => {
	setRendererRpcLagReporter(null);
	vi.restoreAllMocks();
});

describe("renderer RPC stall instrumentation", () => {
	test("measures every unary RPC at the shared client boundary", async () => {
		const reports: Array<{ name: string; durationMs: number }> = [];
		let now = 100;
		vi.spyOn(performance, "now").mockImplementation(() => now);
		setRendererRpcLagReporter((name, durationMs) => {
			reports.push({ name, durationMs });
		});
		const client = instrumentRendererRpcClient({
			"workspace.list": () =>
				Effect.sync(() => {
					expect(getActiveStallOperations()).toContain("rpc:workspace.list");
					now = 340;
					return ["workspace"];
				}),
		});

		expect(await Effect.runPromise(client["workspace.list"]())).toEqual([
			"workspace",
		]);
		expect(reports).toEqual([{ name: "workspace.list", durationMs: 240 }]);
		expect(getActiveStallOperations()).toEqual([]);
	});

	test("does not treat stream-like or invalid client properties as unary RPCs", () => {
		const streamLike = { _tag: "Stream" };
		const client = instrumentRendererRpcClient({
			"session.stream": () => streamLike,
			"unsafe?prompt=private": () => Effect.void,
		});

		expect(client["session.stream"]()).toBe(streamLike);
		expect(client["unsafe?prompt=private"]()).toBe(Effect.void);
	});
});
