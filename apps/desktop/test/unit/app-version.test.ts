import { describe, expect, it } from "vitest";

import { ZUSE_APP_VERSION } from "../../src/app-version.ts";

describe("desktop app version", () => {
	it("uses the product package version instead of the Electron runtime", () => {
		expect(ZUSE_APP_VERSION).toMatch(/^\d+\.\d+\.\d+(?:[-+].+)?$/u);
	});
});
