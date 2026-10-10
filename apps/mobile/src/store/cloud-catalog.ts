import {
	cloudChatPlaceholder,
	cloudSessionPlaceholder,
	compareCloudChatSummaryVersion,
} from "@zuse/client-runtime/cloud-catalog";
import { cloudFailurePresentation } from "@zuse/client-runtime/cloud-failure-presentation";
import { hasCloudEntitlement } from "@zuse/client-runtime/cloud-sandbox-providers";
import { workspaceScopeKey } from "@zuse/client-runtime/environment-scope";
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
	type Organization,
	WorkspaceScope,
} from "@zuse/contracts";
import { Effect, Schema } from "effect";
import { Atom } from "effect/unstable/reactivity";
import { apiBaseUrl } from "~/auth/config";
import type { ConnectionRecord } from "~/lib/connection-records";
import { appAtomRegistry } from "./registry";
import type { ProjectBundle } from "./sessions";

type CloudCatalog = Readonly<{
	accountId: string | null;
	organizations: readonly Organization[];
	scope: WorkspaceScope;
	chats: readonly CloudChatSummary[];
	projects: readonly CloudProject[];
	/** Sandbox providers (boxd, Boat, E2B…) this account can run cloud chats on. */
	providers: readonly CloudProviderOption[];
	/** Each provider's account image, for per-repository readiness. */
	providerImages: readonly CloudAccountImage[];
	/** Cloud Workspace subscription; `null` until known. */
	subscribed: boolean | null;
	/** Why the sandbox provider list could not load, if it failed. */
	providersError: string | null;
	image: CloudAccountImage | null;
	auth: CloudAuthStatus | null;
	loading: boolean;
	error: string | null;
	capabilities: Readonly<Record<string, CapabilityManifest>>;
}>;
const empty = (
	accountId: string | null,
	scope: WorkspaceScope = { kind: "personal" },
): CloudCatalog => ({
	accountId,
	organizations: [],
	scope,
	chats: [],
	projects: [],
	providers: [],
	providerImages: [],
	subscribed: null,
	providersError: null,
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

/** Resolve ownership from the authorized catalog, never from UI selection. */
export const cloudControlForChat = async (workspaceId: string) => {
	const epoch = generation;
	const catalog = appAtomRegistry.get(cloudCatalogAtom);
	const summary = cloudSummary(workspaceId);
	if (catalog.accountId === null || summary === undefined)
		throw new Error(
			"Cloud workspace ownership is not available. Refresh your chats.",
		);
	const { cloudControlClientForWorkspace } = await import("~/rpc/api-client");
	if (epoch !== generation || cloudSummary(workspaceId) === undefined)
		throw new Error(
			"Cloud account changed. Reopen the chat from your account.",
		);
	return cloudControlClientForWorkspace(
		summary.workspaceScope ?? { kind: "personal" },
	);
};
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
let accountGeneration = 0;
let selectionGeneration = 0;
let organizationFlight: Promise<readonly Organization[]> | null = null;
export const cloudCatalogGeneration = () => generation;
/** Capture once per UI operation; switching away and back still invalidates it. */
export const cloudWorkspaceSnapshot = () => {
	const catalog = appAtomRegistry.get(cloudCatalogAtom);
	const epoch = generation;
	return {
		accountId: catalog.accountId,
		scope: catalog.scope,
		isCurrent: () => epoch === generation,
	};
};
/** Configuration forms require current ownership, not just a matching workspace ID. */
export const cloudWorkspaceAdminSnapshot = () => {
	const snapshot = cloudWorkspaceSnapshot();
	const scope = snapshot.scope;
	return {
		...snapshot,
		isCurrent: () =>
			snapshot.accountId !== null &&
			snapshot.isCurrent() &&
			(scope.kind === "personal" ||
				appAtomRegistry
					.get(cloudCatalogAtom)
					.organizations.some(
						(organization) =>
							organization.id === scope.organizationId &&
							organization.role === "admin",
					)),
	};
};
let catalogMutation = 0;
let flight: Promise<void> | null = null;
export const setCloudCatalogAccount = (accountId: string | null): void => {
	if (appAtomRegistry.get(cloudCatalogAtom).accountId === accountId) return;
	accountGeneration++;
	selectionGeneration++;
	organizationFlight = null;
	generation += 1;
	flight = null;
	appAtomRegistry.set(cloudCatalogAtom, empty(accountId));
};

export const refreshCloudOrganizations = (): Promise<
	readonly Organization[]
> => {
	if (appAtomRegistry.get(cloudCatalogAtom).accountId === null)
		return Promise.resolve([]);
	if (organizationFlight !== null) return organizationFlight;
	const account = accountGeneration;
	const pending = (async () => {
		const { organizationControlClientForAccount } = await import(
			"~/rpc/api-client"
		);
		if (account !== accountGeneration)
			throw new Error("Cloud account changed.");
		const organizations = await Effect.runPromise(
			organizationControlClientForAccount()["organizations.list"]({}),
		);
		if (account !== accountGeneration)
			throw new Error("Cloud account changed.");
		const current = appAtomRegistry.get(cloudCatalogAtom);
		const scope = current.scope;
		const membership =
			scope.kind === "organization"
				? organizations.find(
						(organization) => organization.id === scope.organizationId,
					)
				: undefined;
		if (
			scope.kind === "organization" &&
			(current.organizations.find(
				(organization) => organization.id === scope.organizationId,
			)?.role !== membership?.role ||
				((membership === undefined || membership.role === "billing") &&
					(current.loading ||
						current.chats.length > 0 ||
						current.projects.length > 0 ||
						current.auth !== null ||
						current.image !== null)))
		) {
			generation++;
			flight = null;
			appAtomRegistry.set(cloudCatalogAtom, {
				...empty(current.accountId, scope),
				organizations,
				error:
					membership === undefined
						? "This organization is no longer available."
						: null,
			});
			return organizations;
		}
		appAtomRegistry.update(cloudCatalogAtom, (state) => ({
			...state,
			organizations,
		}));
		return organizations;
	})().finally(() => {
		if (organizationFlight === pending) organizationFlight = null;
	});
	organizationFlight = pending;
	return pending;
};

export const setCloudCatalogWorkspace = (scope: WorkspaceScope): void => {
	const validated = Schema.decodeUnknownSync(WorkspaceScope)(scope);
	const current = appAtomRegistry.get(cloudCatalogAtom);
	if (validated.kind === "organization" && current.accountId === null)
		throw new Error("Sign in before selecting an organization.");
	selectionGeneration++;
	if (workspaceScopeKey(validated) === workspaceScopeKey(current.scope)) return;
	generation++;
	flight = null;
	appAtomRegistry.set(cloudCatalogAtom, {
		...empty(current.accountId, validated),
		organizations: current.organizations,
	});
};

/** UI selection checks current membership; a failed selection keeps the old scope. */
export const selectCloudWorkspace = async (
	scope: WorkspaceScope,
): Promise<void> => {
	const validated = Schema.decodeUnknownSync(WorkspaceScope)(scope);
	const selection = ++selectionGeneration;
	const account = accountGeneration;
	if (validated.kind === "organization") {
		const organizations = await refreshCloudOrganizations();
		if (
			!organizations.some(
				(organization) => organization.id === validated.organizationId,
			)
		)
			throw new Error("This organization is no longer available.");
	}
	if (selection !== selectionGeneration || account !== accountGeneration)
		throw new Error("Workspace selection changed. Try again.");
	setCloudCatalogWorkspace(validated);
};

export const refreshCloudCatalog = (): Promise<void> => {
	const current = appAtomRegistry.get(cloudCatalogAtom);
	if (current.accountId === null) return Promise.resolve();
	const selectedScope = current.scope;
	if (
		selectedScope.kind === "organization" &&
		current.organizations.some(
			(organization) =>
				organization.id === selectedScope.organizationId &&
				organization.role === "billing",
		)
	)
		return Promise.resolve();
	if (flight !== null) return flight;
	const epoch = generation;
	const mutation = catalogMutation;
	const scope = appAtomRegistry.get(cloudCatalogAtom).scope;
	appAtomRegistry.update(cloudCatalogAtom, (state) => ({
		...state,
		loading: true,
	}));
	const pending = (async () => {
		const { cloudControlClientForWorkspace } = await import("~/rpc/api-client");
		if (epoch !== generation) return;
		const cloudControlClient = cloudControlClientForWorkspace(scope);
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
		if (
			chats.status === "rejected" &&
			cloudFailurePresentation({ cause: chats.reason })?.kind ===
				"sign-in-required"
		) {
			appAtomRegistry.set(cloudCatalogAtom, {
				...empty(appAtomRegistry.get(cloudCatalogAtom).accountId, scope),
				organizations: appAtomRegistry.get(cloudCatalogAtom).organizations,
				error:
					cloudFailurePresentation({ cause: chats.reason })?.message ??
					"Could not refresh cloud chats. Pull to retry.",
			});
			return;
		}
		if (
			chats.status === "fulfilled" &&
			chats.value.chats.some(
				(row) =>
					workspaceScopeKey(row.workspaceScope ?? { kind: "personal" }) !==
					workspaceScopeKey(scope),
			)
		) {
			appAtomRegistry.set(cloudCatalogAtom, {
				...empty(appAtomRegistry.get(cloudCatalogAtom).accountId, scope),
				organizations: appAtomRegistry.get(cloudCatalogAtom).organizations,
				error:
					"Cloud catalog returned a different workspace. Refresh to retry.",
			});
			return;
		}
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
			providersError:
				providers.status === "rejected"
					? (cloudFailurePresentation({ cause: providers.reason })?.message ??
						"Could not load cloud sandboxes. Pull to retry.")
					: null,
			subscribed: subscribed ?? state.subscribed,
			loading: false,
			error:
				chats.status === "rejected"
					? (cloudFailurePresentation({ cause: chats.reason })?.message ??
						"Could not refresh cloud chats. Pull to retry.")
					: null,
		}));
	})()
		.catch(() => {
			if (epoch !== generation) return;
			appAtomRegistry.update(cloudCatalogAtom, (state) => ({
				...state,
				loading: false,
				error: "Could not refresh cloud chats. Pull to retry.",
			}));
		})
		.finally(() => {
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
	const epoch = generation;
	const cloudControlClient = await cloudControlForChat(workspaceId);
	await Effect.runPromise(
		cloudControlClient["cloud.workspaces.archive"]({ workspaceId }),
	);
	if (epoch !== generation) return;
	catalogMutation += 1;
	appAtomRegistry.update(cloudCatalogAtom, (state) => ({
		...state,
		chats: state.chats.filter((row) => row.workspaceId !== workspaceId),
	}));
	await refreshCloudCatalog();
};
