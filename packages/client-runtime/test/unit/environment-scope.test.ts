import { describe, expect, test } from "vitest";

import {
	environmentRoute,
	parseEnvironmentRoute,
	scopedCacheKey,
} from "../../src/environment-scope.ts";

describe("environment scope", () => {
	test("round trips hosted environment routes", () => {
		expect(environmentRoute("env/a", { threadId: "thread b" })).toBe(
			"/e/env%2Fa/chat/thread%20b",
		);
		expect(parseEnvironmentRoute("/e/env%2Fa/chat/thread%20b")).toEqual({
			environmentId: "env/a",
			kind: "chat",
			resourceId: "thread b",
		});
	});

	test("requires environment identity in cache keys", () => {
		expect(scopedCacheKey("env_one", "project", "same-id")).toBe(
			"env_one:project:same-id",
		);
		expect(scopedCacheKey("env_two", "project", "same-id")).toBe(
			"env_two:project:same-id",
		);
	});

	test("does not treat unscoped paths as a remote environment", () => {
		expect(parseEnvironmentRoute("/chat/thread")).toBeNull();
	});
});
