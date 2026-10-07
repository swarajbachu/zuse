import type {
	CloudAccountImage,
	CloudProviderOption,
	EntitlementList,
} from "@zuse/contracts";

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

/** A provider's image can start chats for this repository. */
export const cloudImageReadyForProject = (
	image: CloudAccountImage | undefined,
	projectId: string | undefined,
): boolean =>
	projectId !== undefined &&
	(image?.state === "ready" || image?.state === "outdated") &&
	image.repositories.some((repository) => repository.projectId === projectId);

/** An active (or still paid-through) Cloud Workspace subscription. */
export const hasCloudEntitlement = (result: EntitlementList): boolean =>
	result.entitlements.some(
		(item) =>
			item.kind === "cloud-workspace" &&
			(item.status === "active" ||
				item.status === "grace" ||
				(item.status === "ended" &&
					item.paidThrough !== undefined &&
					item.paidThrough > Date.now())),
	);

export type CloudSandboxSetup =
	| "ready"
	| "unavailable"
	| "subscription-required"
	| "connect-repository"
	| "building-image"
	| "rebuild-authentication"
	| "update-image";

/**
 * Whether a sandbox provider can start a chat for a project, and what to do
 * first if not. Desktop and mobile word each state themselves.
 */
export const cloudSandboxSetup = (input: {
	readonly image: CloudAccountImage | undefined;
	readonly subscribed: boolean;
	/** `null` when the repository is not connected to Cloud Workspaces. */
	readonly projectId: string | null;
	readonly placementFailed?: boolean;
}): CloudSandboxSetup =>
	input.placementFailed === true || input.image === undefined
		? "unavailable"
		: !input.subscribed
			? "subscription-required"
			: input.projectId === null
				? "connect-repository"
				: cloudImageReadyForProject(input.image, input.projectId)
					? "ready"
					: input.image.state === "building"
						? "building-image"
						: input.image.state === "auth-broken"
							? "rebuild-authentication"
							: "update-image";
