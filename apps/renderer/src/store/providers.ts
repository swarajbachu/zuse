import type {
	AgentAvailability,
	CredentialSetResult,
	ProviderId,
} from "@zuse/contracts";
import { CommandId, EnvironmentId } from "@zuse/contracts";
import { toastManager } from "../components/ui/toast.tsx";
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

let pendingAvailabilityLoad: Promise<void> | null = null;
let activeProviderStatusNotice: string | null = null;

const activeEnvironmentId = (): EnvironmentId =>
	EnvironmentId.make(useEnvironmentCatalogStore.getState().activeEnvironmentId);

const providerCommand = async <Payload, Result>(
	kind: string,
	payload: Payload,
): Promise<Result> => {
	const environmentId = activeEnvironmentId();
	const receipt = await dispatchEnvironmentShellCommand<Payload, Result>({
		environmentId,
		kind,
		commandId: CommandId.make(`provider:${crypto.randomUUID()}`),
		payload,
	});
	return receipt.result;
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
	readonly updateStateByProvider: Partial<
		Record<ProviderId, ProviderUpdateState>
	>;
	readonly load: () => Promise<void>;
	readonly refresh: (force?: boolean) => Promise<void>;
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
	readonly capabilitiesFor: (providerId: ProviderId) => ReadonlyArray<string>;
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
	updateStateByProvider: {},
	load: async () => {
		if (get().availabilityLoaded) return;
		if (pendingAvailabilityLoad !== null) {
			await pendingAvailabilityLoad;
			return;
		}
		const load = get()
			.refresh(false)
			.finally(() => {
				if (pendingAvailabilityLoad === load) pendingAvailabilityLoad = null;
			});
		pendingAvailabilityLoad = load;
		await load;
	},
	refresh: async (force = true) => {
		set({ loading: true, error: null });
		try {
			const environmentId = activeEnvironmentId();
			const list = await providerCommand<
				{ readonly refresh: boolean },
				ReadonlyArray<AgentAvailability>
			>("provider.availability", { refresh: force });
			if (environmentId !== activeEnvironmentId()) return;
			set({ availability: list, loading: false, availabilityLoaded: true });
			notifyProviderStatus(list);
		} catch (err) {
			set({ error: formatError(err), loading: false });
		}
	},
	setProviderUpdateState: (providerId, state) =>
		set((current) => ({
			updateStateByProvider: {
				...current.updateStateByProvider,
				[providerId]: state,
			},
		})),
	capabilitiesFor: (providerId) =>
		get().availability.find((a) => a.providerId === providerId)?.capabilities ??
		EMPTY_CAPABILITIES,
	setCredential: async (providerId, apiKey) => {
		try {
			const result = await providerCommand<
				{ readonly providerId: ProviderId; readonly apiKey: string },
				CredentialSetResult
			>("provider.setCredential", { providerId, apiKey });
			await get().refresh();
			return result;
		} catch (err) {
			set({ error: formatError(err) });
			throw err;
		}
	},
	removeCredential: async (providerId) => {
		try {
			await providerCommand("provider.removeCredential", { providerId });
			await get().refresh();
		} catch (err) {
			set({ error: formatError(err) });
			throw err;
		}
	},
}));
