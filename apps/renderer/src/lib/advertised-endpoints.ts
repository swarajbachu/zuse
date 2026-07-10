import type { AdvertisedEndpoint } from "@zuse/contracts";

export const DEVICES_ENDPOINT_OVERRIDE_KEY = "zuse.devices.endpointOverride.v1";

const isHttpsEndpoint = (endpoint: AdvertisedEndpoint): boolean =>
  endpoint.httpBaseUrl.startsWith("https://") &&
  endpoint.wsBaseUrl.startsWith("wss://");

const rankEndpoint = (endpoint: AdvertisedEndpoint): number => {
  if (isHttpsEndpoint(endpoint)) return 0;
  if (endpoint.reachability === "lan") return 1;
  if (endpoint.reachability === "loopback") return 2;
  return 3;
};

export const selectAdvertisedEndpoint = (
  endpoints: ReadonlyArray<AdvertisedEndpoint> | undefined,
  overrideId?: string | null,
): AdvertisedEndpoint | null => {
  if (endpoints === undefined || endpoints.length === 0) return null;

  const override = overrideId
    ? endpoints.find((endpoint) => endpoint.id === overrideId)
    : undefined;
  if (override !== undefined) return override;

  const serverDefault = endpoints.find((endpoint) => endpoint.isDefault);
  if (serverDefault !== undefined) return serverDefault;

  return (
    [...endpoints].sort((a, b) => rankEndpoint(a) - rankEndpoint(b))[0] ?? null
  );
};

export const readEndpointOverride = (): string | null => {
  if (typeof window === "undefined") return null;
  try {
    const value = window.localStorage
      .getItem(DEVICES_ENDPOINT_OVERRIDE_KEY)
      ?.trim();
    return value && value.length > 0 ? value : null;
  } catch {
    return null;
  }
};

export const writeEndpointOverride = (endpointId: string | null): void => {
  if (typeof window === "undefined") return;
  try {
    if (endpointId === null) {
      window.localStorage.removeItem(DEVICES_ENDPOINT_OVERRIDE_KEY);
    } else {
      window.localStorage.setItem(DEVICES_ENDPOINT_OVERRIDE_KEY, endpointId);
    }
  } catch {
    // Endpoint override is a convenience preference; ignore storage failures.
  }
};
