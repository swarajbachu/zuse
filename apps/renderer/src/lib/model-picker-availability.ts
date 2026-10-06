import {
	type AgentAvailability,
	type CloudAuthStatus,
	ProviderId,
} from "@zuse/contracts";

export const connectedCloudProviders = (
	status: CloudAuthStatus | null,
): ReadonlyArray<ProviderId> =>
	status?.providers
		.filter((provider) => provider.state === "connected")
		.map((provider) => ProviderId.make(provider.providerId)) ?? [];

export type CloudAuthLoadState = "loading" | "ready" | "failed";

/**
 * Why a cloud draft can't be sent, or null when nothing blocks it. A provider
 * that's merely not the selected one is not a blocker: the landing switches
 * the draft to a connected provider on its own.
 */
export const cloudSendBlocker = (
	load: CloudAuthLoadState,
	connectedProviderIds: ReadonlyArray<ProviderId>,
): "auth-check-failed" | "no-connected-agents" | null => {
	if (load === "failed") return "auth-check-failed";
	if (load === "ready" && connectedProviderIds.length === 0)
		return "no-connected-agents";
	return null;
};

export function isModelPickerProviderVisible({
	providerId,
	availability,
	providerEnabled,
	availabilityLoaded = true,
	revealBeforeAvailabilityLoaded = true,
	cloudProviderIds,
}: {
	providerId: ProviderId;
	availability: AgentAvailability | undefined;
	providerEnabled: Partial<Record<ProviderId, boolean>>;
	availabilityLoaded?: boolean;
	revealBeforeAvailabilityLoaded?: boolean;
	cloudProviderIds?: ReadonlyArray<ProviderId>;
}): boolean {
	if (providerEnabled[providerId] === false) return false;
	if (cloudProviderIds !== undefined)
		return cloudProviderIds.includes(providerId);
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
	if (providerId === "pi") return true;
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
