import {
	cloudChatPlaceholder,
	cloudSessionPlaceholder,
	compareCloudChatSummaryVersion,
} from "@zuse/client-runtime/cloud-catalog";
import { cloudFailurePresentation } from "@zuse/client-runtime/cloud-failure-presentation";
import { hasCloudEntitlement } from "@zuse/client-runtime/cloud-sandbox-providers";
import {
	type CapabilityManifest,
	type CloudAccountImage,
	type CloudAuthStatus,
	type CloudChatSummary,
	type CloudProject,
	type CloudProviderOption,
	type CloudWorkspace,
	Folder,
	FolderId,
} from "@zuse/contracts";
import { Effect } from "effect";
import { Atom } from "effect/unstable/reactivity";
import { apiBaseUrl } from "~/auth/config";
import type { ConnectionRecord } from "~/lib/connection-records";
import { appAtomRegistry } from "./registry";
import type { ProjectBundle } from "./sessions";

type CloudCatalog = Readonly<{
	accountId: string | null;
	chats: readonly CloudChatSummary[];
	projects: readonly CloudProject[];
	/** Sandbox providers (boxd, Boat, E2B…) this account can run cloud chats on. */
	providers: readonly CloudProviderOption[];
	/** Each provider's account image, for per-repository readiness. */
	providerImages: readonly CloudAccountImage[];
	/** Cloud Workspace subscription; `null` until known. */
	subscribed: boolean | null;
	image: CloudAccountImage | null;
	auth: CloudAuthStatus | null;
	loading: boolean;
	error: string | null;
	capabilities: Readonly<Record<string, CapabilityManifest>>;
}>;
const empty = (accountId: string | null): CloudCatalog => ({
	accountId,
	chats: [],
	projects: [],
	providers: [],
	providerImages: [],
	subscribed: null,
	image: null,
	auth: null,
	loading: false,
	error: null,
	capabilities: {},
});
export const cloudCatalogAtom = Atom.make<CloudCatalog>(empty(null)).pipe(
	Atom.keepAlive,
);
export const cloudConnectionKey = (workspaceId: string) =>
	`cloud:${workspaceId}`;
export const cloudSummary = (workspaceId: string) =>
	appAtomRegistry
		.get(cloudCatalogAtom)
		.chats.find((row) => row.workspaceId === workspaceId);
export const cloudAuthenticatedProvidersAtom = Atom.make(
	(get) =>
		get(cloudCatalogAtom)
			.auth?.providers.filter((provider) => provider.state === "connected")
			.map((provider) => provider.providerId) ?? [],
);
export const registerCloudSummary = (summary: CloudChatSummary): void => {
	catalogMutation += 1;
	appAtomRegistry.update(cloudCatalogAtom, (state) => ({
		...state,
		chats: [
			summary,
			...state.chats.filter((row) => row.workspaceId !== summary.workspaceId),
		],
	}));
};

export const cloudConnectionsAtom = Atom.make((get): ConnectionRecord[] => {
	const catalog = get(cloudCatalogAtom);
	if (catalog.accountId === null) return [];
	const url = new URL(apiBaseUrl());
	return catalog.chats.map((row) => ({
		key: cloudConnectionKey(row.workspaceId),
		environmentId: row.workspaceId,
		cloudWorkspaceId: row.workspaceId,
		host: url.hostname,
		port: Number(url.port) || 443,
		label: "Cloud",
		source: "cloud",
		updatedAt: row.updatedAt,
		capabilities: catalog.capabilities[row.workspaceId],
	}));
});

export const recordCloudCapabilities = (
	workspaceId: string,
	capabilities: CapabilityManifest,
): void => {
	if (cloudSummary(workspaceId) === undefined) return;
	appAtomRegistry.update(cloudCatalogAtom, (state) => ({
		...state,
		capabilities: { ...state.capabilities, [workspaceId]: capabilities },
	}));
};

/** Metadata is a shell; a live runtime's sessions remain authoritative. */
export const cloudCatalogBundles = (
	rows: readonly CloudChatSummary[],
	existing: Record<string, ProjectBundle[]>,
): Record<string, ProjectBundle[]> => {
	const bundles: Record<string, ProjectBundle[]> = {};
	for (const row of rows) {
		const key = cloudConnectionKey(row.workspaceId);
		const live = existing[key];
		if (live !== undefined && live.length > 0) {
			bundles[key] = live.map((bundle) => {
				const chat = bundle.chats.find((item) => item.id === row.chatId);
				if (
					chat === undefined ||
					chat.updatedAt.getTime() >= row.updatedAt ||
					row.activeSessionId === undefined
				)
					return bundle;
				return {
					...bundle,
					chats: bundle.chats.map((item) =>
						item !== chat
							? item
							: {
									...item,
									title: row.title,
									activeSessionId: row.activeSessionId ?? null,
								},
					),
					sessions:
						row.activeSessionId !== null &&
						!bundle.sessions.some(
							(session) => session.id === row.activeSessionId,
						)
							? [
									...bundle.sessions,
									cloudSessionPlaceholder(
										row,
										bundle.project.id,
										row.activeSessionId,
									),
								]
							: bundle.sessions,
				};
			});
			continue;
		}
		const projectId = FolderId.make(`cloud:${row.projectId}`);
		const chat = cloudChatPlaceholder(row, projectId);
		bundles[key] = [
			{
				project: Folder.make({
					id: projectId,
					name: row.repositoryDisplayName,
					path: row.repositoryIdentity,
					addedAt: new Date(row.createdAt),
				}),
				chats: [chat],
				sessions:
					chat.activeSessionId === null
						? []
						: [cloudSessionPlaceholder(row, projectId, chat.activeSessionId)],
			},
		];
	}
	return bundles;
};

let generation = 0;
let catalogMutation = 0;
let flight: Promise<void> | null = null;
export const setCloudCatalogAccount = (accountId: string | null): void => {
	if (appAtomRegistry.get(cloudCatalogAtom).accountId === accountId) return;
	generation += 1;
	flight = null;
	appAtomRegistry.set(cloudCatalogAtom, empty(accountId));
};

export const refreshCloudCatalog = (): Promise<void> => {
	if (appAtomRegistry.get(cloudCatalogAtom).accountId === null)
		return Promise.resolve();
	if (flight !== null) return flight;
	const epoch = generation;
	const mutation = catalogMutation;
	appAtomRegistry.update(cloudCatalogAtom, (state) => ({
		...state,
		loading: true,
	}));
	const pending = (async () => {
		const { cloudControlClient } = await import("~/rpc/api-client");
		const results = await Promise.allSettled([
			Effect.runPromise(
				cloudControlClient["cloud.chats.list"]({ scope: "active" }),
			),
			Effect.runPromise(cloudControlClient["cloud.projects.list"]()),
			Effect.runPromise(cloudControlClient["cloud.auth.status"]()),
			Effect.runPromise(cloudControlClient["cloud.image.status"]()),
			Effect.runPromise(cloudControlClient["cloud.providers"]()),
		]);
		if (epoch !== generation) return;
		const [chats, projects, auth, image, providers] = results;
		// Placement readiness, as on desktop: each provider's image and the
		// subscription. Failures leave the previous values (shown as unavailable).
		const [providerImages, subscribed] =
			providers.status === "fulfilled"
				? await Promise.all([
						Promise.allSettled(
							providers.value.providers.map((provider) =>
								Effect.runPromise(
									cloudControlClient["cloud.image.status"]({
										providerId: provider.providerId,
									}),
								),
							),
						).then((settled) =>
							settled.flatMap((result) =>
								result.status === "fulfilled" ? [result.value] : [],
							),
						),
						providers.value.entitled !== undefined
							? Promise.resolve(providers.value.entitled)
							: Effect.runPromise(cloudControlClient["machines.entitlements"]())
									.then(hasCloudEntitlement)
									.catch(() => null),
					])
				: [null, null];
		if (epoch !== generation) return;
		appAtomRegistry.update(cloudCatalogAtom, (state) => ({
			...state,
			chats:
				chats.status === "fulfilled" && mutation === catalogMutation
					? chats.value.chats.map((row) => {
							const previous = state.chats.find(
								(candidate) => candidate.workspaceId === row.workspaceId,
							);
							return previous !== undefined &&
								compareCloudChatSummaryVersion(previous, row) > 0
								? previous
								: row;
						})
					: state.chats,
			projects:
				projects.status === "fulfilled"
					? projects.value.projects
					: state.projects,
			auth: auth.status === "fulfilled" ? auth.value : null,
			image: image.status === "fulfilled" ? image.value : state.image,
			providers:
				providers.status === "fulfilled"
					? providers.value.providers
					: state.providers,
			providerImages: providerImages ?? state.providerImages,
			subscribed: subscribed ?? state.subscribed,
			loading: false,
			error:
				chats.status === "rejected"
					? (cloudFailurePresentation({ cause: chats.reason })?.message ??
						"Could not refresh cloud chats. Pull to retry.")
					: null,
		}));
	})().finally(() => {
		if (flight === pending) flight = null;
	});
	flight = pending;
	return pending;
};

export const updateCloudWorkspace = (workspace: CloudWorkspace): void => {
	catalogMutation += 1;
	appAtomRegistry.update(cloudCatalogAtom, (state) => ({
		...state,
		chats: state.chats.map((row) =>
			row.workspaceId !== workspace.workspaceId ||
			row.revision > workspace.revision
				? row
				: { ...row, ...workspace },
		),
	}));
};

export const archiveCloudWorkspace = async (
	workspaceId: string,
): Promise<void> => {
	const { cloudControlClient } = await import("~/rpc/api-client");
	await Effect.runPromise(
		cloudControlClient["cloud.workspaces.archive"]({ workspaceId }),
	);
	catalogMutation += 1;
	appAtomRegistry.update(cloudCatalogAtom, (state) => ({
		...state,
		chats: state.chats.filter((row) => row.workspaceId !== workspaceId),
	}));
	await refreshCloudCatalog();
};
