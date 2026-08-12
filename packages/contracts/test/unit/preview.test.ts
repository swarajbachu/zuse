import { Schema } from "effect";
import { describe, expect, it } from "vitest";

import {
	PreviewForwardRequest,
	PreviewForwardResult,
	PreviewServerList,
} from "../../src/index.ts";

describe("preview contracts", () => {
	it("decodes environment servers without exposing host addresses", () => {
		const list = Schema.decodeUnknownSync(PreviewServerList)({
			servers: [{ name: "node", port: 3001 }],
		});

		expect(list.servers).toEqual([{ name: "node", port: 3001 }]);
		expect(JSON.stringify(list)).not.toContain("178.104");
	});

	it("keeps the forwarded target private-network scoped", () => {
		expect(
			Schema.decodeUnknownSync(PreviewForwardRequest)({ port: 3001 }),
		).toEqual({ port: 3001 });
		expect(
			Schema.decodeUnknownSync(PreviewForwardResult)({
				port: 3001,
				url: "https://build-box.example.ts.net:3001",
				transport: "private-network",
			}),
		).toMatchObject({ transport: "private-network" });
	});
});
