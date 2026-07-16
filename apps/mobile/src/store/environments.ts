import { create } from "zustand";
import { connectionErrorMessage } from "../lib/connection-error-message.ts";
import { visibleConnectionLabel } from "../lib/display-names.ts";
import {
	connectEnvironment,
	getEnvironmentStatus,
	listEnvironments,
} from "../rpc/relay-client.ts";
import { useConnectionsStore } from "./connections.ts";

export type Presence = "online" | "offline" | "unknown";

export type DiscoveredEnvironment = {
	environmentId: string;
	label: string;
	presence: Presence;
};

type EnvironmentsState = {
	environments: DiscoveredEnvironment[];
	loading: boolean;
	error: string | null;
	refresh: () => Promise<void>;
	/** Mint a connect token and register the connection; returns its key. */
	connect: (environmentId: string) => Promise<string>;
};

export const useEnvironmentsStore = create<EnvironmentsState>((set, get) => ({
	environments: [],
	loading: false,
	error: null,
	refresh: async () => {
		set({ loading: true, error: null });
		try {
			const list = await listEnvironments();
			set({
				environments: list.environments.map((environment) => ({
					environmentId: environment.environmentId,
					label: visibleConnectionLabel(environment.label),
					presence: "unknown" as const,
				})),
				loading: false,
			});
			// Fan out presence checks; update each as it lands.
			await Promise.all(
				list.environments.map(async (environment) => {
					try {
						const status = await getEnvironmentStatus(
							environment.environmentId,
						);
						set((state) => ({
							environments: state.environments.map((item) =>
								item.environmentId === environment.environmentId
									? { ...item, presence: status.status }
									: item,
							),
						}));
					} catch (cause) {
						const error = connectionErrorMessage(cause);
						if (
							error.startsWith("Could not authorize") ||
							error.startsWith("Could not verify") ||
							error.startsWith("Your sign-in expired")
						) {
							set({ error });
							return;
						}
						set((state) => ({
							environments: state.environments.map((item) =>
								item.environmentId === environment.environmentId
									? { ...item, presence: "offline" as const }
									: item,
							),
						}));
					}
				}),
			);
		} catch (cause) {
			set({ loading: false, error: connectionErrorMessage(cause) });
		}
	},
	connect: async (environmentId) => {
		const grant = await connectEnvironment(environmentId);
		const label =
			get().environments.find((e) => e.environmentId === environmentId)
				?.label ?? "Computer";
		const record = await useConnectionsStore.getState().addRelay({
			environmentId,
			label,
			wsBaseUrl: grant.endpoint.wsBaseUrl,
			token: grant.connectToken,
		});
		return record.key;
	},
}));
