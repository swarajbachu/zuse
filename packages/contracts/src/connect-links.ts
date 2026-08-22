/**
 * Single source of truth for Zuse connect-link wire formats.
 *
 * The canonical connect link is a browser URL: `<http base>/#pair=<code>`.
 * Native clients also accept the legacy
 * `zuse:///connect/pair?pairingUrl=<ws url>#token=<code>` shape so existing
 * links keep working. Every producer and consumer goes through this module.
 */

export type ConnectLinkKind = "tailscale" | "relay" | "lan" | "remote";

export type ParsedConnectLink = {
	readonly kind: ConnectLinkKind;
	readonly code: string;
	readonly httpBaseUrl: string;
	readonly wsBaseUrl: string;
};

/**
 * Why a candidate string is not a usable connect link. Consumers map these to
 * their own user-facing copy; the reasons themselves stay UI-neutral.
 */
export type ConnectLinkParseFailure =
	| "unrecognized"
	| "wrong-scheme"
	| "incomplete"
	| "unreachable-endpoint"
	| "insecure-endpoint";

export type ConnectLinkParseResult =
	| { readonly ok: true; readonly link: ParsedConnectLink }
	| { readonly ok: false; readonly reason: ConnectLinkParseFailure };

const PAIRING_SCHEMES = new Set(["zuse:", "memoize:"]);

/** Hosted tunnel domains that indicate the link relays through Zuse. */
const RELAY_HOST_SUFFIXES = [".trycloudflare.com", ".stuff.md"] as const;

const RFC1918_PATTERN =
	/^(?:10\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.|169\.254\.)/u;

/**
 * Hosts a plaintext (`ws://` / `http://`) endpoint is allowed to target:
 * loopback, RFC1918 + link-local ranges, and mDNS `.local` names. Everything
 * else must use TLS.
 */
export const isPrivateOrLocalHost = (hostname: string): boolean => {
	const host = hostname.replace(/^\[|\]$/gu, "").toLowerCase();
	if (host === "localhost" || host === "127.0.0.1" || host === "::1") {
		return true;
	}
	if (host.endsWith(".local")) return true;
	if (RFC1918_PATTERN.test(host)) return true;
	// IPv6 unique-local (fc00::/7) and link-local (fe80::/10).
	if (/^f[cd][0-9a-f]{2}:/u.test(host) || host.startsWith("fe80:")) {
		return true;
	}
	return false;
};

/** `ws(s)://host[:port][/path]` → the matching `http(s)://host[:port]` origin. */
export const httpBaseUrlForWsEndpoint = (endpoint: URL): string =>
	`${endpoint.protocol === "wss:" ? "https:" : "http:"}//${endpoint.host}`;

/** `http(s)://host[:port]` base → the matching `ws(s)://host[:port]/rpc` URL. */
export const wsBaseUrlForHttpBase = (httpBaseUrl: string): string => {
	const base = httpBaseUrl.replace(/\/+$/u, "");
	return `${base.replace(/^https:/u, "wss:").replace(/^http:/u, "ws:")}/rpc`;
};

/**
 * Normalize a pairing WS endpoint to the URL clients should dial: a bare
 * origin gets the conventional `/rpc` path, an explicit path is kept.
 */
export const wsBaseUrlForWsEndpoint = (endpoint: URL): string =>
	endpoint.pathname === "/" || endpoint.pathname.length === 0
		? `${endpoint.protocol}//${endpoint.host}/rpc`
		: endpoint.toString().replace(/\/$/u, "");

export const buildConnectDeepLink = (input: {
	readonly wsBaseUrl: string;
	readonly code: string;
}): string =>
	`zuse:///connect/pair?pairingUrl=${encodeURIComponent(input.wsBaseUrl)}#token=${input.code}`;

export const buildBrowserPairUrl = (input: {
	readonly httpBaseUrl: string;
	readonly code: string;
}): string =>
	`${input.httpBaseUrl.replace(/\/+$/u, "")}/#pair=${encodeURIComponent(input.code)}`;

const endpointKind = (endpoint: URL): ConnectLinkKind => {
	if (endpoint.protocol === "ws:") return "lan";
	if (endpoint.hostname.endsWith(".ts.net")) return "tailscale";
	if (
		RELAY_HOST_SUFFIXES.some((suffix) => endpoint.hostname.endsWith(suffix))
	) {
		return "relay";
	}
	return "remote";
};

const parsedLink = (endpoint: URL, code: string): ConnectLinkParseResult => {
	if (endpoint.username.length > 0 || endpoint.password.length > 0) {
		return { ok: false, reason: "unreachable-endpoint" };
	}
	if (
		endpoint.protocol !== "wss:" &&
		!(endpoint.protocol === "ws:" && isPrivateOrLocalHost(endpoint.hostname))
	) {
		return { ok: false, reason: "insecure-endpoint" };
	}
	return {
		ok: true,
		link: {
			kind: endpointKind(endpoint),
			code,
			httpBaseUrl: httpBaseUrlForWsEndpoint(endpoint),
			wsBaseUrl: wsBaseUrlForWsEndpoint(endpoint),
		},
	};
};

/**
 * Parse and classify a connect link. Secure (`wss:`) endpoints are accepted
 * for any host; plaintext (`ws:`) endpoints only for private/local hosts —
 * a LAN pairing is later verified against the environment's signed identity,
 * which a public plaintext endpoint could not be.
 */
export const parseConnectLink = (value: string): ConnectLinkParseResult => {
	let outer: URL;
	try {
		outer = new URL(value.trim());
	} catch {
		return { ok: false, reason: "unrecognized" };
	}
	if (outer.protocol === "http:" || outer.protocol === "https:") {
		if (outer.username.length > 0 || outer.password.length > 0) {
			return { ok: false, reason: "unreachable-endpoint" };
		}
		const code = new URLSearchParams(outer.hash.replace(/^#/u, "")).get("pair");
		if (code === null || code.length === 0) {
			return { ok: false, reason: "incomplete" };
		}
		if (outer.protocol === "http:" && !isPrivateOrLocalHost(outer.hostname)) {
			return { ok: false, reason: "insecure-endpoint" };
		}
		return parsedLink(new URL(wsBaseUrlForHttpBase(outer.origin)), code);
	}
	if (!PAIRING_SCHEMES.has(outer.protocol)) {
		return { ok: false, reason: "wrong-scheme" };
	}
	const pairingUrl = outer.searchParams.get("pairingUrl");
	const code = outer.hash.startsWith("#token=")
		? decodeURIComponent(outer.hash.slice("#token=".length))
		: "";
	if (pairingUrl === null || code.length === 0) {
		return { ok: false, reason: "incomplete" };
	}
	let endpoint: URL;
	try {
		endpoint = new URL(pairingUrl);
	} catch {
		return { ok: false, reason: "unreachable-endpoint" };
	}
	return parsedLink(endpoint, code);
};

// ---------------------------------------------------------------------------
// Pairing codes
// ---------------------------------------------------------------------------

/**
 * Alphabet for short human-typable pairing codes: uppercase without the
 * lookalikes I/L/O/U/0/1. 8 characters ≈ 39 bits, which is ample behind the
 * server's pairing rate limiter and 5-minute expiry.
 */
export const SHORT_PAIRING_CODE_ALPHABET = "ABCDEFGHJKMNPQRSTVWXYZ23456789";
export const SHORT_PAIRING_CODE_LENGTH = 8;

const SHORT_CODE_SHAPE = /^[a-z0-9]{4}[\s-]?[a-z0-9]{4}$/iu;

/** `ABCDEFGH` → `ABCD-EFGH` for display; other code shapes pass through. */
export const formatPairingCodeForDisplay = (code: string): string =>
	code.length === SHORT_PAIRING_CODE_LENGTH && !code.includes("-")
		? `${code.slice(0, 4)}-${code.slice(4)}`
		: code;

/**
 * Canonicalize user-typed pairing input. Short codes are case-insensitive
 * and tolerate the display dash; legacy `zp_…` codes are case-sensitive
 * random strings and must pass through untouched.
 */
export const normalizePairingCodeInput = (value: string): string => {
	const trimmed = value.trim();
	return SHORT_CODE_SHAPE.test(trimmed)
		? trimmed.replace(/[\s-]/gu, "").toUpperCase()
		: trimmed;
};
