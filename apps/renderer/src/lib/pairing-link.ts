/**
 * Pure classification of a Zuse connect link, used for the subtle transport
 * subtext in the Add-computer dialog. Mirrors the desktop parser's shape
 * checks (`pairingUrl` + `#token=` + secure `wss://`, no userinfo) without
 * performing any I/O — the desktop main process stays the authority on
 * whether a link actually pairs.
 */

export type PairingLinkKind = "tailscale" | "relay" | "remote" | "invalid";

const PAIRING_SCHEMES = new Set(["zuse:", "memoize:"]);

/** Hosted tunnel domains that indicate the link relays through Zuse. */
const RELAY_HOST_SUFFIXES = [".trycloudflare.com"] as const;

export const describePairingLinkKind = (link: string): PairingLinkKind => {
	let outer: URL;
	try {
		outer = new URL(link.trim());
	} catch {
		return "invalid";
	}
	if (!PAIRING_SCHEMES.has(outer.protocol)) return "invalid";
	const pairingUrl = outer.searchParams.get("pairingUrl");
	if (pairingUrl === null || !outer.hash.startsWith("#token=")) {
		return "invalid";
	}
	let endpoint: URL;
	try {
		endpoint = new URL(pairingUrl);
	} catch {
		return "invalid";
	}
	if (
		endpoint.protocol !== "wss:" ||
		endpoint.username.length > 0 ||
		endpoint.password.length > 0
	) {
		return "invalid";
	}
	if (endpoint.hostname.endsWith(".ts.net")) return "tailscale";
	if (
		RELAY_HOST_SUFFIXES.some((suffix) => endpoint.hostname.endsWith(suffix))
	) {
		return "relay";
	}
	return "remote";
};
