import { Atom } from "effect/unstable/reactivity";

import { connectionErrorMessage } from "../lib/connection-error-message.ts";
import { visibleConnectionLabel } from "../lib/display-names.ts";
import {
	connectEnvironment,
	getEnvironmentStatus,
	listEnvironments,
} from "../rpc/relay-client.ts";
import { addRelayConnection } from "./connections.ts";
import { appAtomRegistry, batchAtomUpdates } from "./registry.tsx";

export type Presence = "online" | "offline" | "unknown";

export type DiscoveredEnvironment = {
	environmentId: string;
	label: string;
	presence: Presence;
};

export const environmentsAtom = Atom.make<DiscoveredEnvironment[]>([]).pipe(
	Atom.keepAlive,
);
export const environmentsLoadingAtom = Atom.make(false).pipe(Atom.keepAlive);
export const environmentsErrorAtom = Atom.make<string | null>(null).pipe(
	Atom.keepAlive,
);

const patchPresence = (environmentId: string, presence: Presence): void => {
	appAtomRegistry.update(environmentsAtom, (environments) =>
		environments.map((item) =>
			item.environmentId === environmentId ? { ...item, presence } : item,
		),
	);
};

export const refreshEnvironments = async (): Promise<void> => {
	batchAtomUpdates(() => {
		appAtomRegistry.set(environmentsLoadingAtom, true);
		appAtomRegistry.set(environmentsErrorAtom, null);
	});
	try {
		const list = await listEnvironments();
		batchAtomUpdates(() => {
			appAtomRegistry.set(
				environmentsAtom,
				list.environments.map((environment) => ({
					environmentId: environment.environmentId,
					label: visibleConnectionLabel(environment.label),
					presence: "unknown" as const,
				})),
			);
			appAtomRegistry.set(environmentsLoadingAtom, false);
		});
		// Fan out presence checks; update each as it lands.
		await Promise.all(
			list.environments.map(async (environment) => {
				try {
					const status = await getEnvironmentStatus(environment.environmentId);
					patchPresence(environment.environmentId, status.status);
				} catch (cause) {
					const error = connectionErrorMessage(cause);
					if (
						error.startsWith("Could not authorize") ||
						error.startsWith("Could not verify") ||
						error.startsWith("Your sign-in expired")
					) {
						appAtomRegistry.set(environmentsErrorAtom, error);
						return;
					}
					patchPresence(environment.environmentId, "offline");
				}
			}),
		);
	} catch (cause) {
		batchAtomUpdates(() => {
			appAtomRegistry.set(environmentsLoadingAtom, false);
			appAtomRegistry.set(environmentsErrorAtom, connectionErrorMessage(cause));
		});
	}
};

/** Mint a connect token and register the connection; returns its key. */
export const connectToEnvironment = async (
	environmentId: string,
): Promise<string> => {
	const grant = await connectEnvironment(environmentId);
	const label =
		appAtomRegistry
			.get(environmentsAtom)
			.find((e) => e.environmentId === environmentId)?.label ?? "Computer";
	const record = await addRelayConnection({
		environmentId,
		label,
		wsBaseUrl: grant.endpoint.wsBaseUrl,
		token: grant.connectToken,
	});
	return record.key;
};

export const resetEnvironmentsRuntime = (): void => {
	batchAtomUpdates(() => {
		appAtomRegistry.set(environmentsAtom, []);
		appAtomRegistry.set(environmentsLoadingAtom, false);
		appAtomRegistry.set(environmentsErrorAtom, null);
	});
};
