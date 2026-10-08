import type {
	CloudAccountImage,
	CloudProject,
	CloudProviderOption,
} from "@zuse/contracts";
import {
	CloudAccountImage as CloudAccountImageSchema,
	CloudAuthStatus,
	CloudGithubStatus,
	CloudProjectList,
	CloudProviderConnectionList,
	CloudProviderList,
	EntitlementList,
} from "@zuse/contracts";
import { Schema } from "effect";

import {
	invalidateControlPlaneCache,
	peekControlPlaneCache,
	runCachedControlPlane,
	runCachedRead,
} from "./control-plane-client.ts";

const cloudWorkspaceCacheKeys = {
	auth: "cloud-workspace:auth",
	connections: "cloud-workspace:connections",
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

const decodeAuth = Schema.decodeUnknownSync(CloudAuthStatus);
export const peekCloudAuth = () =>
	peekControlPlaneCache(cloudWorkspaceCacheKeys.auth, decodeAuth);
export const loadCloudAuth = (refresh = false) =>
	runCachedControlPlane(
		cloudWorkspaceCacheKeys.auth,
		(client) => client["cloud.auth.status"](),
		{ refresh, decode: decodeAuth },
	);
export const peekCloudGithub = () =>
	peekControlPlaneCache(
		cloudWorkspaceCacheKeys.github,
		Schema.decodeUnknownSync(CloudGithubStatus),
	);

const decodeConnections = Schema.decodeUnknownSync(CloudProviderConnectionList);
export const peekCloudProviderConnections = () =>
	peekControlPlaneCache(cloudWorkspaceCacheKeys.connections, decodeConnections);
export const loadCloudProviderConnections = (refresh = false) =>
	runCachedControlPlane(
		cloudWorkspaceCacheKeys.connections,
		(client) => client["cloud.providerConnections.list"](),
		{ refresh, maxAgeMs: 30_000, decode: decodeConnections },
	);
export const cacheCloudProviderConnections = (
	value: CloudProviderConnectionList,
) =>
	runCachedRead(
		cloudWorkspaceCacheKeys.connections,
		() => Promise.resolve(value),
		{ refresh: true, maxAgeMs: 30_000, decode: decodeConnections },
	);
export const peekCloudProviders = () =>
	peekControlPlaneCache(
		cloudWorkspaceCacheKeys.providers,
		Schema.decodeUnknownSync(CloudProviderList),
	);
export const peekCloudEntitlements = () =>
	peekControlPlaneCache(
		cloudWorkspaceCacheKeys.entitlements,
		Schema.decodeUnknownSync(EntitlementList),
	);
export const peekCloudImage = (providerId?: string) =>
	peekControlPlaneCache(
		cloudWorkspaceCacheKeys.image(providerId),
		Schema.decodeUnknownSync(CloudAccountImageSchema),
	);

export const loadCloudProviders = (refresh = false) =>
	runCachedControlPlane(
		cloudWorkspaceCacheKeys.providers,
		(client) => client["cloud.providers"](),
		{
			refresh,
			maxAgeMs: 30_000,
			decode: Schema.decodeUnknownSync(CloudProviderList),
		},
	);

export const invalidateCloudProjects = () =>
	invalidateControlPlaneCache(cloudWorkspaceCacheKeys.projects);

export const loadCloudProjects = (refresh = false) =>
	runCachedControlPlane(
		cloudWorkspaceCacheKeys.projects,
		(client) => client["cloud.projects.list"](),
		{ refresh, decode: Schema.decodeUnknownSync(CloudProjectList) },
	);

export const loadCloudEntitlements = (refresh = false) =>
	runCachedControlPlane(
		cloudWorkspaceCacheKeys.entitlements,
		(client) => client["machines.entitlements"](),
		{
			refresh,
			maxAgeMs: 30_000,
			decode: Schema.decodeUnknownSync(EntitlementList),
		},
	);

export const loadCloudImage = (providerId?: string, refresh = false) =>
	runCachedControlPlane(
		cloudWorkspaceCacheKeys.image(providerId),
		(client) => client["cloud.image.status"]({ providerId }),
		{ refresh, decode: Schema.decodeUnknownSync(CloudAccountImageSchema) },
	);

export const loadCloudGithub = (refresh = false) =>
	runCachedControlPlane(
		cloudWorkspaceCacheKeys.github,
		(client) => client["cloud.github.status"](),
		{
			refresh,
			maxAgeMs: 30_000,
			decode: Schema.decodeUnknownSync(CloudGithubStatus),
		},
	);

export const loadCloudWorkspaces = (refresh = false) =>
	runCachedControlPlane(
		cloudWorkspaceCacheKeys.workspaces,
		(client) => client["cloud.workspaces.list"]({}),
		{ refresh },
	);

export const loadCloudBillingSummary = (refresh = false) =>
	runCachedControlPlane(
		cloudWorkspaceCacheKeys.billingSummary,
		(client) => client["cloud.billing.summary"](),
		{ refresh },
	);

export const loadCloudBillingUsage = (refresh = false) =>
	runCachedControlPlane(
		cloudWorkspaceCacheKeys.billingUsage,
		(client) => client["cloud.billing.usage"]({ limit: 20 }),
		{ refresh },
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

export const loadCloudProviderImages = async (
	providers: readonly Pick<CloudProviderOption, "providerId">[],
	refresh = false,
) => {
	const results = await Promise.allSettled(
		providers.map((provider) => loadCloudImage(provider.providerId, refresh)),
	);
	return {
		images: results.flatMap((result) =>
			result.status === "fulfilled" ? [result.value] : [],
		),
		complete: results.every((result) => result.status === "fulfilled"),
	};
};

export const loadCloudWorkspacePlacement = async (
	refresh = false,
): Promise<CloudWorkspacePlacementSnapshot> => {
	const [providerResult, projectResult] = await Promise.all([
		loadCloudProviders(refresh),
		loadCloudProjects(refresh),
	]);
	const { images } = await loadCloudProviderImages(
		providerResult.providers,
		refresh,
	);
	return {
		providers: providerResult.providers,
		projects: projectResult.projects,
		images,
		subscribed:
			providerResult.entitled ??
			hasCloudEntitlement(await loadCloudEntitlements(refresh)),
	};
};

/** Warm data shared by New Chat and Cloud Workspace settings. */
export const prefetchCloudWorkspaceSession = async (): Promise<void> => {
	const auth = loadCloudAuth().catch(() => undefined);
	const placement = await loadCloudWorkspacePlacement();
	const background: Array<Promise<unknown>> = [
		loadCloudGithub(),
		auth,
		loadCloudWorkspaces(),
	];
	if (placement.subscribed) {
		background.push(loadCloudBillingSummary(), loadCloudBillingUsage());
	}
	await Promise.allSettled(background);
};
