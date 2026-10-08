import type { CloudAccountImage } from "@zuse/contracts";

export const CLOUD_ONBOARDING_RESUME = "zuse:cloud-onboarding:resume";
export const CLOUD_CHECKOUT_STARTED = "zuse:cloud-checkout:started";
export type CloudSetupStep = "github" | "auth" | "image";
export type CloudSetupProgress = Readonly<Record<CloudSetupStep, boolean>>;

export const firstIncompleteCloudStep = (
	progress: CloudSetupProgress,
): CloudSetupStep =>
	!progress.github ? "github" : !progress.auth ? "auth" : "image";

export const cloudOnboardingRequired = (input: {
	readonly subscribed: boolean;
	readonly completed: boolean;
	readonly hasExistingImage: boolean;
}): boolean => input.subscribed && !input.completed && !input.hasExistingImage;

const completionKey = (accountId: string) =>
	`zuse:cloud-onboarding:v1:${accountId}`;
export const cloudOnboardingCompleted = (
	storage: Pick<Storage, "getItem">,
	accountId: string,
): boolean => {
	try {
		return storage.getItem(completionKey(accountId)) === "complete";
	} catch {
		return false;
	}
};
export const completeCloudOnboarding = (
	storage: Pick<Storage, "setItem">,
	accountId: string,
): void => {
	try {
		storage.setItem(completionKey(accountId), "complete");
	} catch {
		/* Server image state remains the fallback. */
	}
};
export const requestCloudOnboarding = (): void => {
	window.dispatchEvent(new Event(CLOUD_ONBOARDING_RESUME));
};

/** Snapshot prerequisites only apply to the provider being configured. */
export const readyCloudOnboardingSnapshot = (
	images: ReadonlyArray<CloudAccountImage>,
	providerId: string | null,
) =>
	images.find(
		(image) =>
			image.providerId === providerId &&
			image.state === "ready" &&
			image.snapshot !== undefined,
	)?.snapshot;
