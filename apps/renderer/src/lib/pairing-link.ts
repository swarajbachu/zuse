/**
 * Pure classification of a Zuse connect link, used for the subtle transport
 * subtext in the Add-computer dialog. Delegates to the shared contracts
 * parser (`parseConnectLink`) so the renderer, desktop main process, and
 * server all agree on what a valid link is — the desktop main process stays
 * the authority on whether a link actually pairs.
 */

import { type ConnectLinkKind, parseConnectLink } from "@zuse/contracts";

export type PairingLinkKind = ConnectLinkKind | "invalid";

export const describePairingLinkKind = (link: string): PairingLinkKind => {
	const result = parseConnectLink(link);
	return result.ok ? result.link.kind : "invalid";
};
