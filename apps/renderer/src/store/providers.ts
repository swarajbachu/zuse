import type {
	AgentAvailability,
	CredentialSetResult,
	ProviderId,
} from "@zuse/contracts";
import { CommandId, EnvironmentId } from "@zuse/contracts";
import { toastManager } from "../components/ui/toast.tsx";
import { applyCloudProviderAuthentication } from "../lib/cloud-provider-availability.ts";
import { cloudSummaryForEnvironment } from "../lib/cloud-workspace-catalog.ts";
import { runControlPlane } from "../lib/control-plane-client.ts";
import { dispatchEnvironmentShellCommand } from "../lib/environment-shell-client-bus.ts";
import { formatError } from "../lib/format-error.ts";
import { getProviderStatusNotice } from "../lib/provider-status.ts";
import { createAtomStore as create } from "../state/atom-store.ts";
import { useEnvironmentCatalogStore } from "./environment-catalog.ts";

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
	readonly updateStateByProvider: Partial<
		Record<ProviderId, ProviderUpdateState>
	>;
	readonly load: () => Promise<void>;
	readonly loadFor: (environmentId: EnvironmentId) => Promise<void>;
	readonly refresh: (force?: boolean) => Promise<void>;
	readonly refreshFor: (
		environmentId: EnvironmentId,
		force?: boolean,
	) => Promise<void>;
	readonly setProviderUpdateState: (
		providerId: ProviderId,
		state: ProviderUpdateState,
	) => void;
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

export const useProvidersStore = create<ProvidersState>((set, get) => ({
	availability: [],
	loading: false,
	availabilityLoaded: false,
	error: null,
	availabilityByEnvironment: {},
	updateStateByProvider: {},
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
			const rawRequest = providerCommand<
				{ readonly refresh: boolean },
				ReadonlyArray<AgentAvailability>
			>(environmentId, "provider.availability", { refresh: force });
			const list = brokered
				? await Promise.all([
						rawRequest,
						runControlPlane((client) => client["cloud.auth.status"]()),
					]).then(([availability, auth]) =>
						applyCloudProviderAuthentication({
							availability,
							auth,
							codexAuthMode: cloudSummary?.codexAuthMode,
							providerAuthMode: cloudSummary?.providerAuthMode,
						}),
					)
				: await rawRequest;
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
	setProviderUpdateState: (providerId, state) =>
		set((current) => ({
			updateStateByProvider: {
				...current.updateStateByProvider,
				[providerId]: state,
			},
		})),
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
			await get().refresh();
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
			await get().refresh();
		} catch (err) {
			set({ error: formatError(err) });
			throw err;
		}
	},
}));
