import type { AgentAvailability, ProviderId } from "@zuse/contracts";

export function isModelPickerProviderVisible({
  providerId,
  availability,
  providerEnabled,
  availabilityLoaded = true,
}: {
  providerId: ProviderId;
  availability: AgentAvailability | undefined;
  providerEnabled: Partial<Record<ProviderId, boolean>>;
  availabilityLoaded?: boolean;
}): boolean {
  if (providerEnabled[providerId] === false) return false;
  if (availability === undefined) return !availabilityLoaded;
  if (!availability.cliInstalled) return false;
  if (availability.status === "error" || availability.status === "disabled") {
    return false;
  }
  if (availability.hasApiKey) return true;
  if (availability.authStatus === "authenticated") return true;
  if (availability.authStatus === "unauthenticated") return false;
  return availability.cliLoggedIn || availability.hasApiKey;
}

export function filterModelPickerRecents<T extends { providerId: ProviderId }>(
  recents: ReadonlyArray<T>,
  visibleProviders: ReadonlySet<ProviderId>,
): T[] {
  return recents.filter((recent) => visibleProviders.has(recent.providerId));
}
