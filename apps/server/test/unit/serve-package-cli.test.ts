import { describe, expect, it } from "vitest";

import { resolveServeDataDir } from "../../src/serve/package-cli.ts";

describe("serve data directory", () => {
	it("uses the stable desktop profile on macOS", () => {
		expect(
			resolveServeDataDir({}, undefined, {
				platform: "darwin",
				homeDir: "/Users/dev",
			}),
		).toBe("/Users/dev/Library/Application Support/Zuse Alpha");
	});

	it("preserves explicit data-directory overrides", () => {
		expect(
			resolveServeDataDir(
				{ ZUSE_USER_DATA: "/tmp/from-env" },
				"/tmp/explicit",
				{ platform: "darwin", homeDir: "/Users/dev" },
			),
		).toBe("/tmp/explicit");
	});
});
