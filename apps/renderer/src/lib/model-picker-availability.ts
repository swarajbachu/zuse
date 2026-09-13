import {
	type AgentAvailability,
	BUILTIN_PROVIDER_IDS,
	type ProviderId,
} from "@zuse/contracts";

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

/**
 * Runtime-only fallback for a persisted default that is currently unavailable.
 * The saved preference is deliberately left untouched so an extension provider
 * is restored as soon as it returns.
 */
export function resolveReadyProvider({
	preferred,
	availability,
	providerEnabled,
	availabilityLoaded,
}: {
	readonly preferred: ProviderId;
	readonly availability: ReadonlyArray<AgentAvailability>;
	readonly providerEnabled: Partial<Record<ProviderId, boolean>>;
	readonly availabilityLoaded: boolean;
}): ProviderId {
	if (!availabilityLoaded) return preferred;
	const byId = new Map(availability.map((item) => [item.providerId, item]));
	if (
		isModelPickerProviderVisible({
			providerId: preferred,
			availability: byId.get(preferred),
			providerEnabled,
		})
	)
		return preferred;
	return (
		BUILTIN_PROVIDER_IDS.find((providerId) =>
			isModelPickerProviderVisible({
				providerId,
				availability: byId.get(providerId),
				providerEnabled,
			}),
		) ?? "claude"
	);
}
