import {
	EnvironmentDescriptor,
	EnvironmentId,
	PairingStartResult,
} from "@zuse/contracts";
import { Schema } from "effect";
import { describe, expect, it } from "vitest";

import {
	makeEnvironmentCapabilities,
	makePairingStartResult,
} from "../../src/lan-auth/handlers.ts";

describe("LAN auth handlers", () => {
	it("returns an encodable pairing start response", () => {
		const response = makePairingStartResult({
			code: "zp_example",
			expiresAt: new Date("2026-07-18T07:49:09.778Z"),
			pairingUrl: "ws://192.168.0.103:47837",
			browserUrl: "http://192.168.0.103:47837/#pair=zp_example",
			qrText:
				"zuse://?pairingUrl=ws%3A%2F%2F192.168.0.103%3A47837#token=zp_example",
		});

		expect(() => Schema.encodeSync(PairingStartResult)(response)).not.toThrow();
	});

	it("returns encodable environment capabilities", () => {
		const response = EnvironmentDescriptor.make({
			environmentId: Schema.decodeUnknownSync(EnvironmentId)("environment-1"),
			providerKind: "desktop",
			endpoint: {
				httpBaseUrl: "http://127.0.0.1:47837",
				wsBaseUrl: "ws://127.0.0.1:47837",
			},
			capabilities: makeEnvironmentCapabilities(true),
		});

		expect(() =>
			Schema.encodeSync(EnvironmentDescriptor)(response),
		).not.toThrow();
		expect(response.capabilities?.features).toContain("desktop-handoff-v1");
	});
});
