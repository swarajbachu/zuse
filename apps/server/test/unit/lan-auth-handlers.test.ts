import { PairingStartResult } from "@zuse/contracts";
import { Schema } from "effect";
import { describe, expect, it } from "vitest";

import { makePairingStartResult } from "../../src/lan-auth/handlers.ts";

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
});
