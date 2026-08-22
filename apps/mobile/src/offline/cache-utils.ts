import { DEFAULT_LOCAL_DESKTOP_PORT, parseConnectLink } from "@zuse/contracts";

export const slugConnectionKey = (key: string): string =>
	key.replace(/[^a-zA-Z0-9._-]+/g, "_");

export const parsePairingUrl = (
	value: string,
): {
	host: string;
	port: number;
	token?: string;
	wsBaseUrl: string;
	httpBaseUrl: string;
} => {
	const shared = parseConnectLink(value);
	if (shared.ok) {
		const endpoint = new URL(shared.link.wsBaseUrl);
		return {
			host: endpoint.hostname,
			port: Number(
				endpoint.port ||
					(endpoint.protocol === "wss:"
						? "443"
						: String(DEFAULT_LOCAL_DESKTOP_PORT)),
			),
			token: shared.link.code,
			wsBaseUrl: shared.link.wsBaseUrl,
			httpBaseUrl: shared.link.httpBaseUrl,
		};
	}
	const url = new URL(value);
	if (url.protocol !== "zuse:") {
		throw new Error("This QR code is not a Zuse pairing code.");
	}
	const pairingUrl = url.searchParams.get("pairingUrl");
	if (pairingUrl === null || pairingUrl.trim().length === 0) {
		throw new Error("This pairing code does not include a server address.");
	}
	const explicitPort = pairingUrl.match(/:(\d+)(?:\/|$)/)?.[1];
	if (
		explicitPort !== undefined &&
		(!Number.isInteger(Number(explicitPort)) || Number(explicitPort) > 65_535)
	) {
		throw new Error("This pairing code has an invalid port.");
	}
	const normalized = pairingUrl.includes("://")
		? new URL(pairingUrl)
		: new URL(`ws://${pairingUrl}`);
	if (normalized.protocol !== "ws:" && normalized.protocol !== "wss:") {
		throw new Error("This pairing code uses an unsupported connection type.");
	}
	const port = Number(
		normalized.port ||
			(normalized.protocol === "wss:"
				? "443"
				: String(DEFAULT_LOCAL_DESKTOP_PORT)),
	);
	if (!Number.isInteger(port) || port < 1 || port > 65_535) {
		throw new Error("This pairing code has an invalid port.");
	}
	const token = url.hash.startsWith("#token=")
		? decodeURIComponent(url.hash.slice("#token=".length))
		: undefined;
	return {
		host: normalized.hostname,
		port,
		wsBaseUrl: normalized.toString().replace(/\/$/u, ""),
		httpBaseUrl: `${normalized.protocol === "wss:" ? "https:" : "http:"}//${normalized.host}`,
		token,
	};
};
