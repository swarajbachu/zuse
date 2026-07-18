import { describe, expect, test, vi } from "vitest";

import { isLegacyPairingUrl, pairWithDesktop } from "../../../src/lib/pairing";

describe("mobile pairing operation", () => {
	test("adds scanned connections as paired", async () => {
		const add = vi.fn(async (input) => ({ key: "env-1", ...input }));

		const result = await pairWithDesktop(
			"zuse:///connect/pair?pairingUrl=ws%3A%2F%2F192.168.1.2%3A8787#token=zp_code",
			add,
		);

		expect(add).toHaveBeenCalledWith({
			host: "192.168.1.2",
			port: 8787,
			token: "zp_code",
			source: "paired",
		});
		expect(result).toMatchObject({ key: "env-1" });
	});

	test("rejects a pairing link without a token", async () => {
		await expect(
			pairWithDesktop(
				"zuse:///connect/pair?pairingUrl=ws%3A%2F%2F192.168.1.2%3A8787",
				vi.fn(),
			),
		).rejects.toThrow("does not include a pairing token");
	});

	test("routes legacy external pairing links through the shared flow", () => {
		expect(
			isLegacyPairingUrl(
				"zuse://?pairingUrl=ws%3A%2F%2F192.168.1.2%3A8787#token=zp_code",
			),
		).toBe(true);
		expect(
			isLegacyPairingUrl(
				"zuse:///connect/pair?pairingUrl=ws%3A%2F%2F192.168.1.2%3A8787#token=zp_code",
			),
		).toBe(false);
	});
});
