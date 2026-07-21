import { describe, expect, test } from "vitest";

import {
	nearbyMacDisplayName,
	normalizeNearbyServices,
} from "../../modules/local-connectivity/src/normalize-nearby-services";

const service = (
	overrides: Partial<
		Parameters<typeof normalizeNearbyServices>[0][number]
	> = {},
) => ({
	id: "route-1",
	name: "MacBook-Pro-3.local",
	type: "_zuse._tcp",
	domain: "local.",
	interfaceName: "en0",
	trustRecordId: null,
	tlsCertificatePin: "certificate-a",
	...overrides,
});

describe("nearby service normalization", () => {
	test("collapses multiple routes for the same certificate identity", () => {
		const result = normalizeNearbyServices([
			service({
				id: "peer-route",
				name: "MacBook-Pro-3.local (2)",
				interfaceName: "awdl0",
			}),
			service({ id: "lan-route" }),
		]);

		expect(result).toHaveLength(1);
		expect(result[0]).toMatchObject({
			id: "certificate-a",
			name: "MacBook-Pro-3.local",
			interfaceName: "en0",
		});
	});

	test("keeps different certificate identities separate", () => {
		const result = normalizeNearbyServices([
			service(),
			service({ id: "route-2", tlsCertificatePin: "certificate-b" }),
		]);

		expect(result).toHaveLength(2);
	});

	test("keeps Mac identity stable while exposing a republished route", () => {
		const [before] = normalizeNearbyServices([
			service({ id: "mac|_zuse._tcp|local.|en0|1" }),
		]);
		const [after] = normalizeNearbyServices([
			service({ id: "mac|_zuse._tcp|local.|en0|2" }),
		]);

		expect(after?.id).toBe(before?.id);
		expect(after?.routeId).not.toBe(before?.routeId);
	});

	test("removes native nulls before they can reach string-only functions", () => {
		const [result] = normalizeNearbyServices([
			service({ interfaceName: null, trustRecordId: null }),
		]);

		expect(result).not.toHaveProperty("interfaceName");
		expect(result).not.toHaveProperty("trustRecordId");
	});

	test("formats Bonjour host names for people", () => {
		expect(nearbyMacDisplayName("MacBook-Pro-3.local (2)")).toBe(
			"MacBook Pro 3",
		);
	});
});
