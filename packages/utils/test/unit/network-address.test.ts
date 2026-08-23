import { describe, expect, it } from "vitest";

import {
	firstReachableIpv4,
	type NetworkInterfaces,
} from "../../src/network-address.js";

const entry = (input: {
	readonly address: string;
	readonly family: "IPv4" | "IPv6";
	readonly internal?: boolean;
}) => ({
	address: input.address,
	family: input.family,
	internal: input.internal ?? false,
	netmask: input.family === "IPv4" ? "255.255.255.0" : "ffff:ffff::",
	cidr: null,
	mac: "00:00:00:00:00:00",
	scopeid: 0,
});

describe("network address", () => {
	it("returns the first externally reachable IPv4 address", () => {
		const interfaces: NetworkInterfaces = {
			lo0: [entry({ address: "127.0.0.1", family: "IPv4", internal: true })],
			en0: [entry({ address: "192.168.1.42", family: "IPv4" })],
		};
		expect(firstReachableIpv4(interfaces)).toBe("192.168.1.42");
	});

	it("skips IPv6 and self-assigned link-local addresses", () => {
		const interfaces: NetworkInterfaces = {
			en0: [
				entry({ address: "fe80::1", family: "IPv6" }),
				entry({ address: "169.254.10.20", family: "IPv4" }),
			],
		};
		expect(firstReachableIpv4(interfaces)).toBeNull();
	});
});
