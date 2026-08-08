import type { SshEnvironmentTarget } from "@zuse/contracts";

import {
	describePairingLinkKind,
	type PairingLinkKind,
} from "./pairing-link.ts";

/**
 * Classification of the "Using other computers" paste box: one field accepts
 * connect links (deep-link or copied browser form) and SSH addresses, and the
 * UI shows what it read before the user commits.
 */
export type ParsedComputerInput =
	| { readonly kind: "empty" }
	| {
			readonly kind: "link";
			readonly link: string;
			readonly linkKind: Exclude<PairingLinkKind, "invalid">;
	  }
	| { readonly kind: "ssh"; readonly target: SshEnvironmentTarget }
	| { readonly kind: "invalid"; readonly message: string };

const PAIR_FRAGMENT = "#pair=";

/**
 * A copied browser link (`https://host/#pair=code`) carries the same pairing
 * code as the deep link — rewrite it into the frozen deep-link form so both
 * copied shapes paste. The `/rpc` path holds for every https-fronted Zuse
 * endpoint (tailnet serve and account tunnels proxy the whole server).
 */
const browserLinkToDeepLink = (raw: string): string => {
	let url: URL;
	try {
		url = new URL(raw);
	} catch {
		return raw;
	}
	if (url.protocol !== "https:" || !url.hash.startsWith(PAIR_FRAGMENT)) {
		return raw;
	}
	const code = decodeURIComponent(url.hash.slice(PAIR_FRAGMENT.length));
	const wsBaseUrl = `wss://${url.host}/rpc`;
	return `zuse:///connect/pair?pairingUrl=${encodeURIComponent(wsBaseUrl)}#token=${code}`;
};

const SSH_INPUT_PATTERN =
	/^(?:ssh\s+)?(?:(?<user>[^\s@]+)@)?(?<host>[A-Za-z0-9._-]+)(?::(?<port>\d{1,5}))?$/u;

export const parseComputerInput = (raw: string): ParsedComputerInput => {
	const trimmed = raw.trim();
	if (trimmed.length === 0) return { kind: "empty" };
	if (trimmed.includes("://")) {
		const link = browserLinkToDeepLink(trimmed);
		const linkKind = describePairingLinkKind(link);
		if (linkKind === "invalid") {
			return {
				kind: "invalid",
				message: "This doesn’t look like a Zuse connect link.",
			};
		}
		return { kind: "link", link, linkKind };
	}
	const match = SSH_INPUT_PATTERN.exec(trimmed);
	const host = match?.groups?.host;
	if (match === null || host === undefined) {
		return {
			kind: "invalid",
			message: "Enter a host like user@build-box:22, or paste a connect link.",
		};
	}
	const portRaw = match.groups?.port;
	const port = portRaw === undefined ? null : Number(portRaw);
	if (port !== null && (port < 1 || port > 65_535)) {
		return { kind: "invalid", message: "SSH ports range from 1 to 65535." };
	}
	return {
		kind: "ssh",
		target: {
			alias: host,
			hostname: host,
			username: match.groups?.user ?? null,
			port,
		},
	};
};
