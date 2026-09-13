import { describe, expect, it } from "vitest";

import { normalizeRepository } from "../../src/cloud-workspace-routes.ts";

describe("cloud repository input", () => {
	it("accepts a host and repository path without an explicit scheme", () => {
		expect(normalizeRepository("github.com/swarajbachu/zuse")).toEqual({
			identity: "github.com/swarajbachu/zuse",
			url: "https://github.com/swarajbachu/zuse.git",
			name: "zuse",
		});
	});
});
