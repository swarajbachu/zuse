import { networkInterfaces } from "node:os";

/**
 * The machine's first externally-routable IPv4 address, used as the LAN
 * advertised host when the listener is bound to a wildcard address and no
 * explicit advertised host is configured.
 */
export const firstNonInternalIpv4 = (): string | null => {
	for (const entries of Object.values(networkInterfaces())) {
		for (const entry of entries ?? []) {
			if (entry.family === "IPv4" && !entry.internal) {
				return entry.address;
			}
		}
	}
	return null;
};
