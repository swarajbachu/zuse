import type { CloudAccountImage } from "@zuse/contracts";

/** Newer build revisions win; only complete responses may remove a provider. */
export const reconcileCloudImages = (
	current: readonly CloudAccountImage[],
	incoming: readonly CloudAccountImage[],
	complete = true,
): readonly CloudAccountImage[] => {
	const revision = (image: CloudAccountImage) =>
		Math.max(image.updatedAt, ...image.builds.map((build) => build.updatedAt));
	const images = complete
		? incoming
		: [
				...incoming,
				...current.filter(
					(image) =>
						!incoming.some((item) => item.providerId === image.providerId),
				),
			];
	return images.map((image) => {
		const previous = current.find(
			(item) => item.providerId === image.providerId,
		);
		return previous && revision(previous) > revision(image) ? previous : image;
	});
};

/** Readiness for a particular repository, not just a completed setup wizard. */
export { cloudImageReadyForProject } from "@zuse/client-runtime/cloud-sandbox-providers";

/** A group is ready only when every currently available provider is ready. */
export const cloudImageGroupStatus = (
	providerIds: readonly string[],
	images: readonly CloudAccountImage[],
): CloudAccountImage | null => {
	const current = providerIds.map((id) =>
		images.find((image) => image.providerId === id),
	);
	if (current.length === 0 || current.some((image) => image === undefined))
		return null;
	for (const state of [
		"building",
		"auth-broken",
		"failed",
		"not-built",
		"outdated",
		"ready",
	] as const) {
		const image = current.find((image) => image?.state === state);
		if (image !== undefined) return image;
	}
	return null;
};

/** Dispatch every build even if one provider rejects its request. */
export const rebuildCloudImages = async (
	providerIds: readonly string[],
	build: (providerId: string) => Promise<CloudAccountImage>,
) => {
	const ids = [...new Set(providerIds)];
	const results = await Promise.allSettled(
		ids.map((id) => Promise.resolve().then(() => build(id))),
	);
	return {
		images: results.flatMap((result) =>
			result.status === "fulfilled" ? [result.value] : [],
		),
		failedProviderIds: ids.filter(
			(_, index) => results[index]?.status === "rejected",
		),
	};
};
