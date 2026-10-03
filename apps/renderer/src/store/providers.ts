import { getLocalEnvironmentId } from "../lib/rpc-client.ts";
import { useUsageLimitsStore } from "./usage-limits.ts";
import "@zuse/i18n/english/providers";
import type {
	AgentAvailability,
	CloudAuthStatus,
	CredentialSetResult,
	ProviderId,
} from "@zuse/contracts";
import { CommandId, EnvironmentId } from "@zuse/contracts";
import { message } from "@zuse/i18n";
import { toastManager } from "../components/ui/toast.tsx";
import { applyCloudProviderAuthentication } from "../lib/cloud-provider-availability.ts";
import { cloudSummaryForEnvironment } from "../lib/cloud-workspace-catalog.ts";
import {
	loadCloudAuth,
	peekCloudAuth,
} from "../lib/cloud-workspace-session-cache.ts";
import { subscribeControlPlaneSessionCache } from "../lib/control-plane-client.ts";
import { dispatchEnvironmentShellCommand } from "../lib/environment-shell-client-bus.ts";
import { formatError } from "../lib/format-error.ts";
import { isHostedProduct } from "../lib/hosted-connect.ts";
import { getProviderStatusNotice } from "../lib/provider-status.ts";
import { runtimeOperationClient } from "../lib/runtime-operation-client.ts";
import { StreamOperationOwner } from "../lib/stream-operation.ts";
import { createAtomStore as create } from "../state/atom-store.ts";
import { useEnvironmentCatalogStore } from "./environment-catalog.ts";
import { useModelCatalogStore } from "./model-catalog.ts";

// Stable reference for the "no capabilities" case so the `capabilitiesFor`
// selector doesn't return a fresh array each call (which would churn the
// subscribers on every unrelated store update).
const EMPTY_CAPABILITIES: ReadonlyArray<string> = [];

export type ProviderUpdateState =
	| { readonly kind: "idle" }
	| { readonly kind: "running"; readonly line: string | null }
	| { readonly kind: "success" }
	| { readonly kind: "failed"; readonly reason: string };

export const IDLE_PROVIDER_UPDATE_STATE: ProviderUpdateState = {
	kind: "idle",
};

/** Update runs are owned per computer and provider, not by the card that started them. */
export const providerUpdateKey = (
	environmentId: string,
	providerId: ProviderId,
): string => `${environmentId}:${providerId}`;

// Live update streams outlive the settings UI: navigating away (or collapsing
// a provider row) must not cancel the install or lose its status.
const providerUpdateOwners = new Map<string, StreamOperationOwner>();

const pendingAvailabilityLoads = new Map<string, Promise<void>>();
let activeProviderStatusNotice: string | null = null;

const activeEnvironmentId = (): EnvironmentId =>
	EnvironmentId.make(useEnvironmentCatalogStore.getState().activeEnvironmentId);

const providerCommand = async <Payload, Result>(
	environmentId: EnvironmentId,
	kind: string,
	payload: Payload,
): Promise<Result> => {
	const receipt = await dispatchEnvironmentShellCommand<Payload, Result>({
		environmentId,
		kind,
		commandId: CommandId.make(`provider:${crypto.randomUUID()}`),
		payload,
	});
	return receipt.result;
};

export type ProviderAvailabilitySnapshot = Readonly<{
	availability: ReadonlyArray<AgentAvailability>;
	loading: boolean;
	availabilityLoaded: boolean;
	error: string | null;
}>;

const EMPTY_AVAILABILITY_SNAPSHOT: ProviderAvailabilitySnapshot = {
	availability: [],
	loading: false,
	availabilityLoaded: false,
	error: null,
};

const notifyProviderStatus = (
	availability: ReadonlyArray<AgentAvailability>,
): void => {
	const notice = getProviderStatusNotice(availability);
	if (notice === null) {
		activeProviderStatusNotice = null;
		return;
	}

	const fingerprint = `${notice.key}:${notice.description}`;
	if (activeProviderStatusNotice === fingerprint) return;
	activeProviderStatusNotice = fingerprint;
	toastManager.add({
		id: notice.key,
		type: "error",
		priority: "high",
		timeout: 8_000,
		title: notice.title,
		description: notice.description,
	});
};

/**
 * Renderer-side cache of provider availability + the credentials sheet
 * controller. Replaces the per-session state that used to live in
 * `agents.ts` — sessions now flow through the messages store.
 */
type ProvidersState = {
	readonly availability: ReadonlyArray<AgentAvailability>;
	readonly loading: boolean;
	readonly availabilityLoaded: boolean;
	readonly error: string | null;
	readonly availabilityByEnvironment: Readonly<
		Record<string, ProviderAvailabilitySnapshot>
	>;
	readonly updateStateByKey: Readonly<Record<string, ProviderUpdateState>>;
	readonly load: () => Promise<void>;
	readonly loadFor: (environmentId: EnvironmentId) => Promise<void>;
	readonly refresh: (force?: boolean) => Promise<void>;
	readonly refreshFor: (
		environmentId: EnvironmentId,
		force?: boolean,
	) => Promise<void>;
	/** Run the provider's update command; a second call while running is a no-op. */
	readonly cancelUpdate: (
		environmentId: string,
		providerId: ProviderId,
	) => void;
	readonly updateProvider: (
		environmentId: string,
		providerId: ProviderId,
	) => Promise<void>;
	/**
	 * Version-gated features the installed CLI supports for `providerId` (the
	 * `capabilities` list from the availability probe). `[]` when the provider
	 * isn't probed yet or declares no gated features. Used to show/hide feature
	 * controls (e.g. Codex goal/fast toggles) before a session exists.
	 */
	readonly capabilitiesFor: (
		providerId: ProviderId,
		environmentId?: EnvironmentId,
	) => ReadonlyArray<string>;
	readonly setCredential: (
		providerId: ProviderId,
		apiKey: string,
	) => Promise<CredentialSetResult>;
	readonly removeCredential: (providerId: ProviderId) => Promise<void>;
};

const hostedAvailability = (
	auth: CloudAuthStatus,
): ReadonlyArray<AgentAvailability> =>
	auth.providers
		.filter((p) => p.providerId === "claude" || p.providerId === "codex")
		.map((p) => ({
			providerId: p.providerId,
			displayName: p.providerId === "claude" ? "Claude" : "Codex",
			runtimeAvailable: p.state === "connected",
			cliInstalled: false,
			cliLoggedIn: false,
			hasApiKey: false,
			authStatus:
				p.state === "connected"
					? ("authenticated" as const)
					: ("unauthenticated" as const),
			status:
				p.state === "connected" ? ("ready" as const) : ("warning" as const),
		}));
const cachedAuth = isHostedProduct() ? peekCloudAuth() : undefined;
const initialAvailability: ProviderAvailabilitySnapshot =
	cachedAuth === undefined
		? EMPTY_AVAILABILITY_SNAPSHOT
		: {
				availability: hostedAvailability(cachedAuth),
				availabilityLoaded: true,
				loading: false,
				error: null,
			};

export const useProvidersStore = create<ProvidersState>((set, get) => ({
	...initialAvailability,
	availabilityByEnvironment: Object.fromEntries(
		cachedAuth === undefined ? [] : [["local", initialAvailability]],
	),
	updateStateByKey: {},
	load: async () => {
		await get().loadFor(activeEnvironmentId());
	},
	loadFor: async (environmentId) => {
		const key = environmentId as string;
		const snapshot = get().availabilityByEnvironment[key];
		if (snapshot?.availabilityLoaded === true) {
			if (environmentId === activeEnvironmentId()) {
				set({
					availability: snapshot.availability,
					loading: snapshot.loading,
					availabilityLoaded: true,
					error: snapshot.error,
				});
			}
			return;
		}
		const pending = pendingAvailabilityLoads.get(key);
		if (pending !== undefined) {
			await pending;
			return;
		}
		const load = get()
			.refreshFor(environmentId, false)
			.finally(() => {
				if (pendingAvailabilityLoads.get(key) === load) {
					pendingAvailabilityLoads.delete(key);
				}
			});
		pendingAvailabilityLoads.set(key, load);
		await load;
	},
	refresh: async (force = true) => {
		await get().refreshFor(activeEnvironmentId(), force);
	},
	refreshFor: async (environmentId, force = true) => {
		const key = environmentId as string;
		const isActive = environmentId === activeEnvironmentId();
		set((state) => ({
			availabilityByEnvironment: {
				...state.availabilityByEnvironment,
				[key]: {
					...(state.availabilityByEnvironment[key] ??
						EMPTY_AVAILABILITY_SNAPSHOT),
					loading: true,
					error: null,
				},
			},
			...(isActive ? { loading: true, error: null } : {}),
		}));
		try {
			const cloudSummary = cloudSummaryForEnvironment(environmentId);
			const brokered =
				cloudSummary?.providerAuthMode === "broker-v1" ||
				cloudSummary?.codexAuthMode === "broker-v1";
			const rawRequest =
				isHostedProduct() && environmentId === "local"
					? loadCloudAuth(force).then((auth) => hostedAvailability(auth))
					: providerCommand<
							{ readonly refresh: boolean },
							ReadonlyArray<AgentAvailability>
						>(environmentId, "provider.availability", { refresh: force });
			const list = brokered
				? await Promise.all([rawRequest, loadCloudAuth(force)]).then(
						([availability, auth]) =>
							applyCloudProviderAuthentication({
								availability,
								auth,
								codexAuthMode: cloudSummary?.codexAuthMode,
								providerAuthMode: cloudSummary?.providerAuthMode,
							}),
					)
				: await rawRequest;
			if (environmentId === getLocalEnvironmentId()) {
				const previous =
					get().availabilityByEnvironment[key]?.availability ?? [];
				for (const provider of list) {
					const old = previous.find(
						(item) => item.providerId === provider.providerId,
					);
					if (
						old &&
						(provider.authStatus === "authenticated" ||
							provider.authStatus === "unauthenticated") &&
						(old.authStatus !== provider.authStatus ||
							old.authEmail !== provider.authEmail ||
							old.authType !== provider.authType)
					)
						useUsageLimitsStore.getState().invalidate(provider.providerId);
				}
			}
			const publishActive = environmentId === activeEnvironmentId();
			set((state) => ({
				availabilityByEnvironment: {
					...state.availabilityByEnvironment,
					[key]: {
						availability: list,
						loading: false,
						availabilityLoaded: true,
						error: null,
					},
				},
				...(publishActive
					? {
							availability: list,
							loading: false,
							availabilityLoaded: true,
							error: null,
						}
					: {}),
			}));
			if (publishActive) notifyProviderStatus(list);
		} catch (err) {
			const error = formatError(err);
			const publishActive = environmentId === activeEnvironmentId();
			set((state) => ({
				availabilityByEnvironment: {
					...state.availabilityByEnvironment,
					[key]: {
						...(state.availabilityByEnvironment[key] ??
							EMPTY_AVAILABILITY_SNAPSHOT),
						loading: false,
						error,
					},
				},
				...(publishActive ? { error, loading: false } : {}),
			}));
		}
	},
	updateProvider: async (environmentId, providerId) => {
		const key = providerUpdateKey(environmentId, providerId);
		if (get().updateStateByKey[key]?.kind === "running") return;
		const setUpdate = (state: ProviderUpdateState) =>
			set((current) => {
				const updateStateByKey = { ...current.updateStateByKey };
				if (state.kind === "idle") delete updateStateByKey[key];
				else updateStateByKey[key] = state;
				return { updateStateByKey };
			});
		const owner = new StreamOperationOwner();
		providerUpdateOwners.get(key)?.cancel();
		providerUpdateOwners.set(key, owner);
		setUpdate({ kind: "running", line: null });
		let completed = false;
		await owner.run(
			async () =>
				(await runtimeOperationClient(environmentId))["provider.update"]({
					providerId,
				}),
			async (event) => {
				if (event._tag === "log") {
					setUpdate({ kind: "running", line: event.text });
					return;
				}
				if (event._tag !== "done") return;
				completed = true;
				if (!event.ok) {
					setUpdate({
						kind: "failed",
						reason: event.reason ?? message("providers:update_failed"),
					});
					return;
				}
				await get().refreshFor(EnvironmentId.make(environmentId));
				if (providerUpdateOwners.get(key) !== owner) return;
				setUpdate({ kind: "success" });
				owner.resetAfter(() => {
					providerUpdateOwners.delete(key);
					setUpdate(IDLE_PROVIDER_UPDATE_STATE);
				});
			},
			(error) => {
				completed = true;
				setUpdate({ kind: "failed", reason: formatError(error) });
			},
		);
		if (!completed && providerUpdateOwners.get(key) === owner)
			setUpdate({
				kind: "failed",
				reason: message("providers:update_incomplete"),
			});
		if (
			providerUpdateOwners.get(key) === owner &&
			get().updateStateByKey[key]?.kind === "failed"
		)
			providerUpdateOwners.delete(key);
	},
	cancelUpdate: (environmentId, providerId) => {
		const key = providerUpdateKey(environmentId, providerId);
		providerUpdateOwners.get(key)?.cancel();
		providerUpdateOwners.delete(key);
		set((current) => ({
			updateStateByKey: {
				...current.updateStateByKey,
				[key]: IDLE_PROVIDER_UPDATE_STATE,
			},
		}));
	},
	capabilitiesFor: (providerId, environmentId) => {
		const availability =
			environmentId === undefined
				? get().availability
				: (get().availabilityByEnvironment[environmentId]?.availability ?? []);
		return (
			availability.find((a) => a.providerId === providerId)?.capabilities ??
			EMPTY_CAPABILITIES
		);
	},
	setCredential: async (providerId, apiKey) => {
		try {
			const environmentId = activeEnvironmentId();
			const result = await providerCommand<
				{ readonly providerId: ProviderId; readonly apiKey: string },
				CredentialSetResult
			>(environmentId, "provider.setCredential", { providerId, apiKey });
			if (environmentId === getLocalEnvironmentId())
				useUsageLimitsStore.getState().invalidate(providerId);
			await get().refresh();
			// A new key can unlock a different live model list (Cursor).
			void useModelCatalogStore.getState().refresh();
			return result;
		} catch (err) {
			set({ error: formatError(err) });
			throw err;
		}
	},
	removeCredential: async (providerId) => {
		try {
			await providerCommand(
				activeEnvironmentId(),
				"provider.removeCredential",
				{
					providerId,
				},
			);
			if (activeEnvironmentId() === getLocalEnvironmentId())
				useUsageLimitsStore.getState().invalidate(providerId);
			await get().refresh();
			void useModelCatalogStore.getState().refresh();
		} catch (err) {
			set({ error: formatError(err) });
			throw err;
		}
	},
}));

// Settings and the web picker share one account status; a background update
// immediately changes model visibility without another blocking probe.
subscribeControlPlaneSessionCache((key) => {
	if (key !== "cloud-workspace:auth" || !isHostedProduct()) return;
	const auth = peekCloudAuth();
	if (auth === undefined) return;
	const snapshot = {
		availability: hostedAvailability(auth),
		availabilityLoaded: true,
		loading: false,
		error: null,
	};
	useProvidersStore.setState((state) => ({
		...(activeEnvironmentId() === "local" ? snapshot : {}),
		availabilityByEnvironment: {
			...state.availabilityByEnvironment,
			local: snapshot,
		},
	}));
});
