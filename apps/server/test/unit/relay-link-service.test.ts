import { afterEach, describe, expect, it } from "vitest";

import { relayRuntimeMetadata } from "../../src/relay/relay-link-service.ts";

const originalRuntimeVersion = process.env.ZUSE_RUNTIME_VERSION;

afterEach(() => {
	if (originalRuntimeVersion === undefined) {
		delete process.env.ZUSE_RUNTIME_VERSION;
		return;
	}
	process.env.ZUSE_RUNTIME_VERSION = originalRuntimeVersion;
});

describe("relay runtime metadata", () => {
	it("reads the runtime version when the heartbeat is created", () => {
		process.env.ZUSE_RUNTIME_VERSION = "0.1.1";
		expect(relayRuntimeMetadata().runtimeVersion).toBe("0.1.1");

		process.env.ZUSE_RUNTIME_VERSION = "0.1.2";
		expect(relayRuntimeMetadata().runtimeVersion).toBe("0.1.2");
	});
});
