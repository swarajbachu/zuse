import { describe, expect, it } from "vitest";

import { createDeferredRuntime } from "../../src/lib/deferred-runtime.ts";

describe("deferred runtime", () => {
	it("replays work queued during loading exactly once and in order", async () => {
		const runtimeReady = Promise.withResolvers<{ events: Array<string> }>();
		let loads = 0;
		const deferred = createDeferredRuntime(() => {
			loads += 1;
			return runtimeReady.promise;
		});

		expect(loads).toBe(0);

		deferred.dispatch((runtime) => runtime.events.push("initialize"));
		deferred.dispatch((runtime) => runtime.events.push("app opened"));
		expect(loads).toBe(1);

		const runtime = { events: [] as Array<string> };
		runtimeReady.resolve(runtime);
		await deferred.ready();
		deferred.dispatch((loaded) => loaded.events.push("screen viewed"));

		expect(runtime.events).toEqual([
			"initialize",
			"app opened",
			"screen viewed",
		]);
	});
});
