import type {
	EnvironmentId,
	ProviderUsageLimits,
	UsageLimitHistoryPoint,
} from "@zuse/contracts";
import {
	CommandId,
	EnvironmentId as EnvironmentIdSchema,
} from "@zuse/contracts";
import { dispatchEnvironmentShellCommand } from "../lib/environment-shell-client-bus.ts";
import { getLocalEnvironmentId } from "../lib/rpc-client.ts";
import { createAtomStore as create } from "../state/atom-store.ts";

let pendingLoad: Promise<void> | null = null;
const STALE_AFTER_MS = 60_000;
type UsageCommand = <Result>(
	environmentId: EnvironmentId,
	kind: string,
	payload: Readonly<Record<string, unknown>>,
) => Promise<Result>;
let runUsageCommand: UsageCommand = async <Result>(
	environmentId: EnvironmentId,
	kind: string,
	payload: Readonly<Record<string, unknown>>,
) => {
	return (
		await dispatchEnvironmentShellCommand<
			Readonly<Record<string, unknown>>,
			Result
		>({
			environmentId,
			kind,
			commandId: CommandId.make(`usage:${crypto.randomUUID()}`),
			payload,
		})
	).result;
};
export const setUsageCommandForTest = (command: UsageCommand): void => {
	runUsageCommand = command;
};

type State = {
	providers: ReadonlyArray<ProviderUsageLimits>;
	history: ReadonlyArray<UsageLimitHistoryPoint>;
	loading: boolean;
	error: string | null;
	lastLoadedAt: number | null;
	load: () => Promise<void>;
	loadHistory: () => Promise<void>;
	refresh: (
		force?: boolean,
		providerId?: import("@zuse/contracts").ProviderId,
	) => Promise<void>;
};
export const useUsageLimitsStore = create<State>((set, get) => ({
	providers: [],
	history: [],
	loading: false,
	error: null,
	lastLoadedAt: null,
	load: async () => {
		const lastLoadedAt = get().lastLoadedAt;
		const kiro = get().providers.find((p) => p.providerId === "kiro");
		const kiroNeedsRetry =
			kiro !== undefined &&
			kiro.windows.length === 0 &&
			(kiro.unavailableReason === "no-credentials" ||
				kiro.unavailableReason === "expired" ||
				kiro.unavailableReason === "error");
		// Soft-load when fresh — but never skip if Kiro previously missed; a
		// sticky no-credentials cache is what made signed-in accounts look empty.
		if (
			!kiroNeedsRetry &&
			lastLoadedAt !== null &&
			Date.now() - lastLoadedAt < STALE_AFTER_MS
		)
			return;
		if (pendingLoad !== null) {
			await pendingLoad;
			return;
		}
		const load = get()
			.refresh(kiroNeedsRetry)
			.finally(() => {
				if (pendingLoad === load) pendingLoad = null;
			});
		pendingLoad = load;
		await load;
	},
	loadHistory: async () => {
		try {
			const response = await runUsageCommand<{
				readonly points: ReadonlyArray<UsageLimitHistoryPoint>;
			}>(
				EnvironmentIdSchema.make(getLocalEnvironmentId()),
				"usage.limits.history",
				{},
			);
			set({ history: response.points });
		} catch {
			// History is supplementary; live limit cards remain useful without it.
		}
	},
	refresh: async (force = false, providerId) => {
		set({ loading: true, error: null });
		try {
			// Provider allowances come from credentials on this physical desktop,
			// not from whichever local/SSH/cloud environment is currently selected.
			const response = await runUsageCommand<{
				readonly providers: ReadonlyArray<ProviderUsageLimits>;
			}>(EnvironmentIdSchema.make(getLocalEnvironmentId()), "usage.limits", {
				forceRefresh: force,
				providerId,
			});
			set({
				providers: providerId
					? [
							...get().providers.filter(
								(item) => item.providerId !== providerId,
							),
							...response.providers,
						]
					: response.providers,
				loading: false,
				lastLoadedAt: Date.now(),
			});
		} catch (error) {
			set({
				loading: false,
				error: error instanceof Error ? error.message : String(error),
			});
		}
	},
}));
