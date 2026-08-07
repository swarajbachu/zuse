import { describe, expect, it } from "vitest";

import {
	assertSupportedNodeVersion,
	nodeMajorVersion,
} from "../../src/node-version.ts";

describe("zusehq Node.js version guard", () => {
	it("accepts supported Node.js releases", () => {
		expect(() => assertSupportedNodeVersion("22.5.0")).not.toThrow();
		expect(() => assertSupportedNodeVersion("24.18.1")).not.toThrow();
	});

	it("rejects old and malformed versions with actionable guidance", () => {
		expect(() => assertSupportedNodeVersion("18.19.1")).toThrow(
			/Node\.js 22 or newer.*npx zusehq serve/u,
		);
		expect(() => assertSupportedNodeVersion("unknown")).toThrow(
			/current: unknown/u,
		);
	});

	it("parses optional v-prefixed versions", () => {
		expect(nodeMajorVersion("v24.18.1")).toBe(24);
		expect(nodeMajorVersion("unknown")).toBeNull();
	});
});
