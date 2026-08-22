import { describe, expect, it } from "vitest";

import { installCryptoRandomUuidCompatibility } from "../../src/lib/crypto-compatibility.ts";

describe("renderer crypto compatibility", () => {
	it("provides randomUUID when an HTTP LAN origin exposes only getRandomValues", () => {
		let next = 0;
		const target = {
			getRandomValues: (values: Uint8Array) => {
				for (const index of values.keys()) values[index] = next++;
				return values;
			},
		} as unknown as Crypto;

		installCryptoRandomUuidCompatibility(target);

		expect(target.randomUUID()).toBe("00010203-0405-4607-8809-0a0b0c0d0e0f");
	});

	it("keeps the browser implementation when it is available", () => {
		const native = () => "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee" as const;
		const target = {
			randomUUID: native,
			getRandomValues: () => {
				throw new Error("fallback should not run");
			},
		} as unknown as Crypto;

		installCryptoRandomUuidCompatibility(target);

		expect(target.randomUUID).toBe(native);
	});
});
