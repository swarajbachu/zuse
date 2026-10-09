import {
	type CloudSandboxSetup,
	cloudSandboxSetup,
} from "@zuse/client-runtime/cloud-sandbox-providers";
import type { CloudAccountImage } from "@zuse/contracts";

const SETUP_LABEL: Record<Exclude<CloudSandboxSetup, "ready">, string> = {
	unavailable: "Unavailable",
	"subscription-required": "Subscription required",
	"connect-repository": "Connect a repository",
	"building-image": "Building cloud image",
	"rebuild-authentication": "Rebuild authentication",
	"update-image": "Update cloud image",
};

export type CloudSandboxStatus = Readonly<{
	setup: CloudSandboxSetup;
	/** Short reason shown beside the provider; `null` when ready. */
	label: string | null;
}>;

/**
 * Readiness of one sandbox provider. Pass `projectId` for a chosen repository;
 * omit it to check the provider for any connected repository.
 */
export const cloudSandboxStatus = (
	catalog: Readonly<{
		providerImages: readonly CloudAccountImage[];
		subscribed: boolean | null;
	}>,
	providerId: string,
	projectId?: string | null,
): CloudSandboxStatus => {
	const image = catalog.providerImages.find(
		(candidate) => candidate.providerId === providerId,
	);
	const setup = cloudSandboxSetup({
		image,
		subscribed: catalog.subscribed === true,
		projectId:
			projectId === undefined
				? (image?.repositories[0]?.projectId ?? null)
				: projectId,
	});
	return { setup, label: setup === "ready" ? null : SETUP_LABEL[setup] };
};
