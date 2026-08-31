import {
	AdvertisedEndpoint,
	type AdvertisedEndpointHostedHttpsCompatibility,
	type AdvertisedEndpointReachability,
	type AdvertisedEndpointStatus,
	EnvironmentEndpoint,
} from "@zuse/contracts";

import type { LanAuthConfigShape } from "./services/lan-auth-service.ts";

export interface ApiEndpointConfig {
	readonly tunnelHostname?: string;
	readonly linked: boolean;
	readonly heartbeatActive: boolean;
}

const isLoopbackHost = (host: string): boolean =>
	host === "127.0.0.1" || host === "::1" || host === "localhost";

const isHttpsEndpoint = (httpBaseUrl: string, wsBaseUrl: string): boolean =>
	httpBaseUrl.startsWith("https://") && wsBaseUrl.startsWith("wss://");

const compatibilityFor = (
	httpBaseUrl: string,
	wsBaseUrl: string,
): AdvertisedEndpointHostedHttpsCompatibility =>
	isHttpsEndpoint(httpBaseUrl, wsBaseUrl)
		? "compatible"
		: "mixed-content-blocked";

const defaultRank = (endpoint: AdvertisedEndpoint): number => {
	if (isHttpsEndpoint(endpoint.httpBaseUrl, endpoint.wsBaseUrl)) return 0;
	if (endpoint.reachability === "lan") return 1;
	if (endpoint.reachability === "loopback") return 2;
	return 3;
};

const withDefault = (
	endpoints: ReadonlyArray<AdvertisedEndpoint>,
): ReadonlyArray<AdvertisedEndpoint> => {
	const defaultEndpoint = [...endpoints].sort(
		(a, b) => defaultRank(a) - defaultRank(b),
	)[0];
	if (defaultEndpoint === undefined) return endpoints;
	const defaultId = defaultEndpoint.id;
	return endpoints.map((endpoint) =>
		AdvertisedEndpoint.make({
			...endpoint,
			isDefault: endpoint.id === defaultId,
		}),
	);
};

const coreEndpoint = (input: {
	readonly id: string;
	readonly label: string;
	readonly host: string;
	readonly port: number;
	readonly reachability: AdvertisedEndpointReachability;
}): AdvertisedEndpoint =>
	AdvertisedEndpoint.make({
		id: input.id,
		label: input.label,
		providerKind: "core",
		httpBaseUrl: `http://${input.host}:${input.port}`,
		wsBaseUrl: `ws://${input.host}:${input.port}`,
		reachability: input.reachability,
		compatibility: { hostedHttpsApp: "mixed-content-blocked" },
		status: "available",
		isDefault: false,
	});

export const buildAdvertisedEndpoints = (input: {
	readonly lan: LanAuthConfigShape;
	readonly api?: ApiEndpointConfig | null;
}): ReadonlyArray<AdvertisedEndpoint> => {
	const endpoints: AdvertisedEndpoint[] = [];
	const port = input.lan.port;

	if (port !== null) {
		const advertisedHost = input.lan.advertisedHost;
		if (advertisedHost !== null && !isLoopbackHost(advertisedHost)) {
			endpoints.push(
				coreEndpoint({
					id: "core:lan",
					label: "LAN",
					host: advertisedHost,
					port,
					reachability: "lan",
				}),
			);
		}

		endpoints.push(
			coreEndpoint({
				id: "core:loopback",
				label: "This Mac",
				host: "127.0.0.1",
				port,
				reachability: "loopback",
			}),
		);
	}

	const tunnelHostname = input.api?.tunnelHostname?.trim();
	if (tunnelHostname) {
		const httpBaseUrl = `https://${tunnelHostname}`;
		const wsBaseUrl = `wss://${tunnelHostname}`;
		const status: AdvertisedEndpointStatus =
			input.api?.linked === true
				? input.api.heartbeatActive
					? "available"
					: "unknown"
				: "unavailable";
		endpoints.push(
			AdvertisedEndpoint.make({
				id: "tunnel:managed-api",
				label: "Managed tunnel",
				providerKind: "tunnel",
				httpBaseUrl,
				wsBaseUrl,
				reachability: "tunnel",
				compatibility: {
					hostedHttpsApp: compatibilityFor(httpBaseUrl, wsBaseUrl),
				},
				status,
				isDefault: false,
			}),
		);
	}

	return withDefault(endpoints);
};

/**
 * Resolve the descriptor endpoint from the same ranked endpoint set exposed to
 * clients. Keeping this selection here prevents local-only desktop runtimes
 * from being rejected even though their loopback server is available.
 */
export const resolveDefaultEnvironmentEndpoint = (
	endpoints: ReadonlyArray<AdvertisedEndpoint>,
): EnvironmentEndpoint | null => {
	const endpoint = endpoints.find((candidate) => candidate.isDefault);
	return endpoint === undefined
		? null
		: EnvironmentEndpoint.make({
				httpBaseUrl: endpoint.httpBaseUrl,
				wsBaseUrl: endpoint.wsBaseUrl,
			});
};
