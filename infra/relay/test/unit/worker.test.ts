import { describe, expect, test } from "vitest";

import { hyperdrivePoolConfig } from "../../src/worker.ts";

describe("relay worker database lifecycle", () => {
	test("fails connection acquisition instead of leaving requests suspended", () => {
		const config = hyperdrivePoolConfig("postgres://hyperdrive");

		expect(config).toMatchObject({
			connectionString: "postgres://hyperdrive",
			max: 1,
			connectionTimeoutMillis: 5_000,
		});
		expect(config).not.toHaveProperty("maxUses");
	});
});
