import {
  AdvertisedEndpoint,
  type AdvertisedEndpointHostedHttpsCompatibility,
  type AdvertisedEndpointReachability,
  type AdvertisedEndpointStatus,
} from "@zuse/wire";

import type { LanAuthConfigShape } from "./services/lan-auth-service.ts";

export interface RelayEndpointConfig {
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
  if (endpoints.length === 0) return endpoints;
  const defaultId = [...endpoints].sort(
    (a, b) => defaultRank(a) - defaultRank(b),
  )[0]!.id;
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
  readonly relay?: RelayEndpointConfig | null;
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

  const tunnelHostname = input.relay?.tunnelHostname?.trim();
  if (tunnelHostname) {
    const httpBaseUrl = `https://${tunnelHostname}`;
    const wsBaseUrl = `wss://${tunnelHostname}/rpc`;
    const status: AdvertisedEndpointStatus =
      input.relay?.linked === true
        ? input.relay.heartbeatActive
          ? "available"
          : "unknown"
        : "unavailable";
    endpoints.push(
      AdvertisedEndpoint.make({
        id: "tunnel:managed-relay",
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
