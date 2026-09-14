import "@zuse/i18n/english/connections";
import type {
	ApiLinkStatus,
	PairingStartResult,
	TailnetShareState,
} from "@zuse/contracts";
import { buildBrowserPairUrl } from "@zuse/contracts";
import { message as uiMessage } from "@zuse/i18n";

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
			return {
				description: uiMessage(
					"connections:remote_access_on_managed_by_zuse_serve",
				),
				action: "details",
			};
		}
		return {
			description: uiMessage("connections:remote_access_private_access", {
				value1: String(state.dnsName ? ` at ${state.dnsName}` : " is ready"),
			}),
			action: "turn-off",
		};
	}
	if (state?.availability === "conflict" && state.conflict !== null) {
		const { reason, targetPort } = state.conflict;
		const port = targetPort === null ? "" : ` (port ${targetPort})`;
		if (reason === "unresponsive-owner") {
			return {
				description: uiMessage(
					"connections:remote_access_a_previous_serve_route_is_no_longer_responding",
					{ port: String(port) },
				),
				action: null,
			};
		}
		if (reason === "foreign-app") {
			return {
				description: uiMessage(
					"connections:remote_access_tailscale_serve_is_used_by_another_app",
					{ port: String(port) },
				),
				action: null,
			};
		}
		return {
			description: uiMessage(
				"connections:remote_access_tailscale_serve_has_an_existing_configuration_zuse_doesn_t_recogn",
			),
			action: null,
		};
	}
	if (state?.availability === "signed-out") {
		return state.backendState === "Stopped"
			? {
					description: uiMessage(
						"connections:remote_access_tailscale_is_off_turn_it_on_in_the_tailscale_app",
					),
					action: null,
				}
			: {
					description: uiMessage(
						"connections:remote_access_open_tailscale_and_sign_in_to_use_private_access",
					),
					action: null,
				};
	}
	return {
		description: uiMessage(
			"connections:remote_access_connect_privately_from_devices_on_the_same_tailnet",
		),
		action: "set-up",
	};
};
