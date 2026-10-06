import type { CloudAccountImage } from "@zuse/contracts";
import { reconcileCloudImages } from "./cloud-image-group.ts";
import { setCloudSettingsUnbuiltChanges } from "./cloud-settings-guard.ts";
import {
	hasCloudEntitlement,
	loadCloudEntitlements,
	loadCloudImage,
	loadCloudProviders,
} from "./cloud-workspace-session-cache.ts";

const listeners = new Set<(images: readonly CloudAccountImage[]) => void>();
export const subscribeCloudImages = (
	listener: (images: readonly CloudAccountImage[]) => void,
): (() => void) => {
	listeners.add(listener);
	listener(latestImages);
	return () => {
		listeners.delete(listener);
	};
};

let generation = 0;
let requestSequence = 0;
let latestImages: readonly CloudAccountImage[] = [];

/** Refresh every placement, including the default alias used by Settings. */
export const refreshCloudImages = async (): Promise<
	readonly CloudAccountImage[]
> => {
	const epoch = generation;
	const sequence = ++requestSequence;
	// Provider-key access arrives with the provider list; a subscription is
	// the fallback for APIs that do not report eligibility there.
	const { providers, entitled } = await loadCloudProviders(true);
	const hasAccess =
		entitled ?? hasCloudEntitlement(await loadCloudEntitlements(true));
	if (epoch !== generation || sequence !== requestSequence) return latestImages;
	if (!hasAccess) {
		latestImages = [];
		setCloudSettingsUnbuiltChanges(false);
		for (const listener of listeners) listener(latestImages);
		return latestImages;
	}
	const results = await Promise.allSettled([
		loadCloudImage(undefined, true),
		...providers.map((provider) => loadCloudImage(provider.providerId, true)),
	]);
	if (epoch !== generation || sequence !== requestSequence) return latestImages;
	const images = new Map(
		latestImages.map((image) => [image.providerId, image]),
	);
	for (const result of results) {
		if (result.status === "fulfilled")
			images.set(result.value.providerId, result.value);
	}
	latestImages = reconcileCloudImages(latestImages, [
		...images.values(),
	]).filter((image) =>
		providers.some((provider) => provider.providerId === image.providerId),
	);

	// Only warn when no image can serve a cloud chat yet. Providers the user
	// does not build for would otherwise block leaving Settings every time.
	setCloudSettingsUnbuiltChanges(
		!latestImages.some((image) => image.state === "ready") &&
			latestImages.some(
				(image) => image.state === "outdated" || image.state === "not-built",
			),
	);
	for (const listener of listeners) listener(latestImages);
	if (results.some((result) => result.status === "rejected"))
		throw new Error("Some cloud image statuses could not be refreshed.");
	return latestImages;
};

export const resetCloudImageMonitor = (): void => {
	generation += 1;
	latestImages = [];
	setCloudSettingsUnbuiltChanges(false);
};
