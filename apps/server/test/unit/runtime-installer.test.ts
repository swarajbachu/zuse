import { describe, expect, test } from "vitest";

import {
	durableRuntimeExecutable,
	latestServeRuntimeVersion,
} from "../../src/serve/runtime-installer.ts";

describe("Serve runtime installer", () => {
	test("uses a versioned durable executable path", () => {
		expect(durableRuntimeExecutable("/data/zuse", "1.2.3")).toBe(
			"/data/zuse/runtime/1.2.3/node_modules/@zusehq/serve/dist/bin.mjs",
		);
	});

	test("reads the latest version from the package registry", async () => {
		const version = await latestServeRuntimeVersion(
			async () =>
				new Response(JSON.stringify({ version: "1.4.0" }), {
					status: 200,
					headers: { "content-type": "application/json" },
				}),
		);
		expect(version).toBe("1.4.0");
	});
});
