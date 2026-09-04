import type { AgentAvailability, ProviderId } from "@zuse/contracts";

export function isModelPickerProviderVisible({
	providerId,
	availability,
	providerEnabled,
	availabilityLoaded = true,
	revealBeforeAvailabilityLoaded = true,
}: {
	providerId: ProviderId;
	availability: AgentAvailability | undefined;
	providerEnabled: Partial<Record<ProviderId, boolean>>;
	availabilityLoaded?: boolean;
	revealBeforeAvailabilityLoaded?: boolean;
}): boolean {
	if (providerEnabled[providerId] === false) return false;
	if (availability === undefined) {
		return !availabilityLoaded && revealBeforeAvailabilityLoaded;
	}
	if (!(availability.runtimeAvailable ?? availability.cliInstalled)) {
		return false;
	}
	if (availability.status === "error" || availability.status === "disabled") {
		return false;
	}
	if (providerId === "cursor") {
		return availability.hasApiKey && availability.apiKeyStatus !== "invalid";
	}
	if (availability.hasApiKey) return true;
	if (availability.authStatus === "authenticated") return true;
	if (availability.authStatus === "unauthenticated") return false;
	return availability.cliLoggedIn || availability.hasApiKey;
}

export const selectAuthenticatedProvider = ({
	preferredProviderId,
	providerIds,
	availability,
	providerEnabled,
}: {
	readonly preferredProviderId: ProviderId;
	readonly providerIds: ReadonlyArray<ProviderId>;
	readonly availability: ReadonlyArray<AgentAvailability>;
	readonly providerEnabled: Partial<Record<ProviderId, boolean>>;
}): ProviderId | null => {
	const availabilityById = new Map(
		availability.map((entry) => [entry.providerId, entry] as const),
	);
	const ordered = [
		preferredProviderId,
		...providerIds.filter((providerId) => providerId !== preferredProviderId),
	];
	return (
		ordered.find((providerId) =>
			isModelPickerProviderVisible({
				providerId,
				availability: availabilityById.get(providerId),
				providerEnabled,
				availabilityLoaded: true,
			}),
		) ?? null
	);
};
