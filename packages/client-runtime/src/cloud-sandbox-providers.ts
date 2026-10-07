import type { CloudProviderOption } from "@zuse/contracts";

/** Display name for a cloud sandbox provider id. */
export const cloudProviderLabel = (providerId: string): string =>
	providerId === "box"
		? "Boat"
		: providerId === "boxd"
			? "boxd"
			: providerId === "e2b"
				? "E2B"
				: providerId;

/** Keep server ordering for other providers, with boxd recommended first. */
export const orderedCloudProviders = (
	providers: readonly CloudProviderOption[],
) =>
	[...providers].sort(
		(a, b) => Number(b.providerId === "boxd") - Number(a.providerId === "boxd"),
	);

export const selectedCloudProvider = (
	providers: readonly CloudProviderOption[],
	selected: string | null,
	readyProviderIds?: readonly string[],
): string | null => {
	const ordered = orderedCloudProviders(providers);
	const ready = ordered.filter((provider) =>
		readyProviderIds?.includes(provider.providerId),
	);
	return (
		ready.find((provider) => provider.providerId === selected)?.providerId ??
		ready[0]?.providerId ??
		providers.find((provider) => provider.providerId === selected)
			?.providerId ??
		ordered[0]?.providerId ??
		null
	);
};
