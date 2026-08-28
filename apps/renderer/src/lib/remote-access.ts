import type {
	ApiLinkStatus,
	PairingStartResult,
	TailnetShareState,
} from "@zuse/contracts";
import { buildBrowserPairUrl } from "@zuse/contracts";

/**
 * How a pairing link reaches this computer. Ordered by preference:
 * account (works anywhere) > tailscale (same tailnet) > local (same network).
 */
export type PairingMethod = "account" | "tailscale" | "local";

export interface PairingReadiness {
	readonly status: ApiLinkStatus | null;
	readonly tailnet: TailnetShareState | null;
	readonly networkEnabled: boolean;
}

/**
 * Rewrite a server-issued pairing result against a specific endpoint. The
 * wire format is frozen — mobile app and browser both parse these shapes.
 */
export const pairingWithEndpoint = (
	pairing: PairingStartResult,
	httpBaseUrl: string,
	wsBaseUrl: string,
): PairingStartResult => {
	const browserUrl = buildBrowserPairUrl({ httpBaseUrl, code: pairing.code });
	return {
		...pairing,
		pairingUrl: wsBaseUrl,
		browserUrl,
		qrText: browserUrl,
	};
};

/** Stable browser address, without its optional one-time pairing fragment. */
export const browserBaseUrl = (pairing: PairingStartResult): string => {
	const url = new URL(pairing.browserUrl);
	url.hash = "";
	return url.toString().replace(/\/$/u, "");
};

export const accountPairingEndpoint = (status: ApiLinkStatus | null) =>
	status?.advertisedEndpoints?.find(
		(endpoint) =>
			(endpoint.reachability === "tunnel" ||
				endpoint.reachability === "public") &&
			endpoint.status !== "unavailable",
	);

/**
 * A tailnet route can carry this app's pairing traffic only when this app
 * owns it. A `zuse serve`-managed route serves the daemon's auth, not this
 * app's — pairing against it would mint tokens the daemon rejects.
 */
const tailnetPairingReady = (tailnet: TailnetShareState | null): boolean =>
	tailnet?.enabled === true &&
	tailnet.dnsName !== null &&
	tailnet.managedBy !== "zuse-serve";

/**
 * Rewrite the pairing for a connection method, or return null when that
 * method has no usable endpoint. Callers must not fall back to the raw
 * LAN pairing silently — snap to another ready method instead.
 */
export const pairingForMethod = (
	pairing: PairingStartResult,
	method: PairingMethod,
	status: ApiLinkStatus | null,
	tailnet: TailnetShareState | null,
): PairingStartResult | null => {
	if (method === "account") {
		const endpoint = accountPairingEndpoint(status);
		return endpoint === undefined
			? null
			: pairingWithEndpoint(pairing, endpoint.httpBaseUrl, endpoint.wsBaseUrl);
	}
	if (method === "tailscale") {
		if (
			tailnet?.enabled === true &&
			tailnet.dnsName !== null &&
			tailnet.managedBy !== "zuse-serve"
		) {
			return pairingWithEndpoint(
				pairing,
				`https://${tailnet.dnsName}`,
				`wss://${tailnet.dnsName}/rpc`,
			);
		}
		return null;
	}
	// Local network: the server-issued pairing already targets the LAN host.
	return pairing;
};

/** Every connection method that can serve a pairing link right now, best first. */
export const readyMethods = ({
	status,
	tailnet,
	networkEnabled,
}: PairingReadiness): ReadonlyArray<PairingMethod> => [
	...(accountPairingEndpoint(status) !== undefined
		? (["account"] as const)
		: []),
	...(tailnetPairingReady(tailnet) ? (["tailscale"] as const) : []),
	...(networkEnabled ? (["local"] as const) : []),
];

export const bestReadyMethod = (
	readiness: PairingReadiness,
): PairingMethod | null => readyMethods(readiness)[0] ?? null;

export type TailnetStatusAction = "turn-off" | "details" | "set-up" | null;

export interface TailnetStatusLine {
	readonly description: string;
	readonly action: TailnetStatusAction;
}

/** One-line Tailscale row status + which control belongs next to it. */
export const tailnetStatusLine = (
	state: TailnetShareState | null,
): TailnetStatusLine => {
	if (state?.enabled === true) {
		if (state.managedBy === "zuse-serve") {
			return { description: "On · Managed by zuse serve.", action: "details" };
		}
		return {
			description: `Private access${state.dnsName ? ` at ${state.dnsName}` : " is ready"}.`,
			action: "turn-off",
		};
	}
	if (state?.availability === "conflict" && state.conflict !== null) {
		const { reason, targetPort } = state.conflict;
		const port = targetPort === null ? "" : ` (port ${targetPort})`;
		if (reason === "unresponsive-owner") {
			return {
				description: `A previous serve route${port} is no longer responding.`,
				action: null,
			};
		}
		if (reason === "foreign-app") {
			return {
				description: `Tailscale Serve is used by another app${port}.`,
				action: null,
			};
		}
		return {
			description:
				"Tailscale Serve has an existing configuration Zuse doesn’t recognize.",
			action: null,
		};
	}
	if (state?.availability === "signed-out") {
		return state.backendState === "Stopped"
			? {
					description: "Tailscale is off. Turn it on in the Tailscale app.",
					action: null,
				}
			: {
					description: "Open Tailscale and sign in to use private access.",
					action: null,
				};
	}
	return {
		description: "Connect privately from devices on the same tailnet.",
		action: "set-up",
	};
};
