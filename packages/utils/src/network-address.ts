import {
	type NetworkInterfaceInfo,
	networkInterfaces as readNetworkInterfaces,
} from "node:os";

export type NetworkInterfaces = NodeJS.Dict<NetworkInterfaceInfo[]>;

/**
 * Resolve the IPv4 address other devices can use to reach this machine.
 * Callers may inject a snapshot for deterministic tests; production callers
 * use the live operating-system interfaces by default.
 */
export const firstReachableIpv4 = (
	interfaces: NetworkInterfaces = readNetworkInterfaces(),
): string | null => {
	for (const entries of Object.values(interfaces)) {
		for (const entry of entries ?? []) {
			if (
				entry.family === "IPv4" &&
				!entry.internal &&
				!entry.address.startsWith("169.254.")
			) {
				return entry.address;
			}
		}
	}
	return null;
};
