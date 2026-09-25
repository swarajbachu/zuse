import type {
	CloudAccountImage,
	CloudProject,
	CloudProviderOption,
} from "@zuse/contracts";

import { runCachedControlPlane } from "./control-plane-client.ts";

const MUTABLE_CLOUD_CACHE_MAX_AGE_MS = 5_000;
const CLOUD_CACHE_OPTIONS = {
	maxAgeMs: 60_000,
	staleWhileRevalidate: true,
} as const;

const cloudWorkspaceCacheKeys = {
	providers: "cloud-workspace:providers",
	projects: "cloud-workspace:projects",
	entitlements: "cloud-workspace:entitlements",
	github: "cloud-workspace:github",
	workspaces: "cloud-workspace:workspaces",
	billingSummary: "cloud-workspace:billing-summary",
	billingUsage: "cloud-workspace:billing-usage",
	image: (providerId?: string) =>
		`cloud-workspace:image:${providerId ?? "default"}`,
} as const;

export const loadCloudProviders = (refresh = false) =>
	runCachedControlPlane(
		cloudWorkspaceCacheKeys.providers,
		(client) => client["cloud.providers"](),
		{ ...CLOUD_CACHE_OPTIONS, refresh },
	);

export const loadCloudProjects = (refresh = false) =>
	runCachedControlPlane(
		cloudWorkspaceCacheKeys.projects,
		(client) => client["cloud.projects.list"](),
		{ ...CLOUD_CACHE_OPTIONS, refresh },
	);

export const loadCloudEntitlements = (refresh = false) =>
	runCachedControlPlane(
		cloudWorkspaceCacheKeys.entitlements,
		(client) => client["machines.entitlements"](),
		{ ...CLOUD_CACHE_OPTIONS, refresh },
	);

export const loadCloudImage = (providerId?: string, refresh = false) =>
	runCachedControlPlane(
		cloudWorkspaceCacheKeys.image(providerId),
		(client) => client["cloud.image.status"]({ providerId }),
		{
			...CLOUD_CACHE_OPTIONS,
			refresh,
			maxAgeMs: MUTABLE_CLOUD_CACHE_MAX_AGE_MS,
		},
	);

export const loadCloudGithub = (refresh = false) =>
	runCachedControlPlane(
		cloudWorkspaceCacheKeys.github,
		(client) => client["cloud.github.status"](),
		{ ...CLOUD_CACHE_OPTIONS, refresh },
	);

export const loadCloudWorkspaces = (refresh = false) =>
	runCachedControlPlane(
		cloudWorkspaceCacheKeys.workspaces,
		(client) => client["cloud.workspaces.list"]({}),
		{
			...CLOUD_CACHE_OPTIONS,
			refresh,
			maxAgeMs: MUTABLE_CLOUD_CACHE_MAX_AGE_MS,
		},
	);

export const loadCloudBillingSummary = (refresh = false) =>
	runCachedControlPlane(
		cloudWorkspaceCacheKeys.billingSummary,
		(client) => client["cloud.billing.summary"](),
		{ ...CLOUD_CACHE_OPTIONS, refresh },
	);

export const loadCloudBillingUsage = (refresh = false) =>
	runCachedControlPlane(
		cloudWorkspaceCacheKeys.billingUsage,
		(client) => client["cloud.billing.usage"]({ limit: 20 }),
		{ ...CLOUD_CACHE_OPTIONS, refresh },
	);

export const hasCloudEntitlement = (
	result: Awaited<ReturnType<typeof loadCloudEntitlements>>,
): boolean =>
	result.entitlements.some(
		(item) =>
			item.kind === "cloud-workspace" &&
			(item.status === "active" ||
				item.status === "grace" ||
				(item.status === "ended" &&
					item.paidThrough !== undefined &&
					item.paidThrough > Date.now())),
	);

type CloudWorkspacePlacementSnapshot = Readonly<{
	providers: ReadonlyArray<CloudProviderOption>;
	projects: ReadonlyArray<CloudProject>;
	images: ReadonlyArray<CloudAccountImage>;
	subscribed: boolean;
}>;

export const loadCloudWorkspacePlacement = async (
	refresh = false,
): Promise<CloudWorkspacePlacementSnapshot> => {
	const [providerResult, projectResult, entitlementResult] = await Promise.all([
		loadCloudProviders(refresh),
		loadCloudProjects(refresh),
		loadCloudEntitlements(refresh),
	]);
	const imageResults = await Promise.allSettled(
		providerResult.providers.map((provider) =>
			loadCloudImage(provider.providerId, refresh),
		),
	);
	return {
		providers: providerResult.providers,
		projects: projectResult.projects,
		images: imageResults.flatMap((result) =>
			result.status === "fulfilled" ? [result.value] : [],
		),
		subscribed: hasCloudEntitlement(entitlementResult),
	};
};

/** Warm data shared by New Chat and Cloud Workspace settings. */
export const prefetchCloudWorkspaceSession = async (): Promise<void> => {
	const placement = await loadCloudWorkspacePlacement();
	const background: Array<Promise<unknown>> = [
		loadCloudGithub(),
		loadCloudWorkspaces(),
	];
	if (placement.subscribed) {
		background.push(loadCloudBillingSummary(), loadCloudBillingUsage());
	}
	await Promise.allSettled(background);
};
