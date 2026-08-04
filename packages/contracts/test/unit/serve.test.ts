import { Schema } from "effect";
import { describe, expect, it } from "vitest";

import { ServeStatusV1 } from "../../src/serve.ts";

describe("ServeStatusV1", () => {
	it("accepts the stable status JSON contract", () => {
		const status = Schema.decodeUnknownSync(ServeStatusV1)({
			schemaVersion: 1,
			computer: "devbox",
			service: "running",
			tunnel: "configured",
			runtimeVersion: "1.2.3",
			agents: ["Codex"],
			reachable: true,
			environmentId: "environment-1",
			durable: true,
			dataDir: "/srv/zuse",
			appUrl: "https://app.zuse.dev",
		});

		expect(status.schemaVersion).toBe(1);
	});

	it.each([
		["running", "configured"],
		["stopped", "unavailable"],
		["missing", "unavailable"],
	] as const)("accepts the %s service output state", (service, tunnel) => {
		expect(() =>
			Schema.decodeUnknownSync(ServeStatusV1)({
				schemaVersion: 1,
				computer: "devbox",
				service,
				tunnel,
				runtimeVersion: "1.2.3",
				agents: [],
				reachable: false,
				environmentId: null,
				durable: service !== "missing",
				dataDir: "/srv/zuse",
				appUrl: "https://app.zuse.dev",
			}),
		).not.toThrow();
	});

	it("rejects incompatible schema versions and states", () => {
		expect(() =>
			Schema.decodeUnknownSync(ServeStatusV1)({
				schemaVersion: 2,
				computer: "devbox",
				service: "starting",
				tunnel: "configured",
				runtimeVersion: "1.2.3",
				agents: [],
				reachable: false,
				environmentId: null,
				durable: false,
				dataDir: "/srv/zuse",
				appUrl: "https://app.zuse.dev",
			}),
		).toThrow();
	});
});
