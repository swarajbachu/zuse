import { Atom } from "effect/unstable/reactivity";

import { connectionErrorMessage } from "../lib/connection-error-message.ts";
import { visibleConnectionLabel } from "../lib/display-names.ts";
import {
	connectEnvironment,
	getEnvironmentStatus,
	listEnvironments,
} from "../rpc/api-client.ts";
import { cloudCatalogAtom, cloudCatalogGeneration } from "./cloud-catalog.ts";
import { addApiConnection } from "./connections.ts";
import { appAtomRegistry, batchAtomUpdates } from "./registry.tsx";

export type Presence = "online" | "offline" | "unknown";

export type DiscoveredEnvironment = {
	environmentId: string;
	label: string;
	presence: Presence;
};

const personalEnvironmentsAtom = Atom.make<DiscoveredEnvironment[]>([]).pipe(
	Atom.keepAlive,
);
const personalEnvironmentsLoadingAtom = Atom.make(false).pipe(Atom.keepAlive);
const personalEnvironmentsErrorAtom = Atom.make<string | null>(null).pipe(
	Atom.keepAlive,
);

export const environmentsAtom = Atom.make((get) =>
	get(cloudCatalogAtom).scope.kind === "personal"
		? get(personalEnvironmentsAtom)
		: [],
);
export const environmentsLoadingAtom = Atom.make(
	(get) =>
		get(cloudCatalogAtom).scope.kind === "personal" &&
		get(personalEnvironmentsLoadingAtom),
);
export const environmentsErrorAtom = Atom.make((get) =>
	get(cloudCatalogAtom).scope.kind === "personal"
		? get(personalEnvironmentsErrorAtom)
		: null,
);

const patchPresence = (environmentId: string, presence: Presence): void => {
	appAtomRegistry.update(personalEnvironmentsAtom, (environments) =>
		environments.map((item) =>
			item.environmentId === environmentId ? { ...item, presence } : item,
		),
	);
};

let refreshGeneration = 0;
export const refreshEnvironments = async (): Promise<void> => {
	if (appAtomRegistry.get(cloudCatalogAtom).scope.kind !== "personal") return;
	const scopeGeneration = cloudCatalogGeneration();
	const request = ++refreshGeneration;
	const current = () =>
		scopeGeneration === cloudCatalogGeneration() &&
		request === refreshGeneration;
	batchAtomUpdates(() => {
		appAtomRegistry.set(personalEnvironmentsLoadingAtom, true);
		appAtomRegistry.set(personalEnvironmentsErrorAtom, null);
	});
	try {
		const list = await listEnvironments();
		if (!current()) return;
		batchAtomUpdates(() => {
			appAtomRegistry.set(
				personalEnvironmentsAtom,
				list.environments.map((environment) => ({
					environmentId: environment.environmentId,
					label: visibleConnectionLabel(environment.label),
					presence: "unknown" as const,
				})),
			);
			appAtomRegistry.set(personalEnvironmentsLoadingAtom, false);
		});
		// Fan out presence checks; update each as it lands.
		await Promise.all(
			list.environments.map(async (environment) => {
				try {
					const status = await getEnvironmentStatus(environment.environmentId);
					if (!current()) return;
					patchPresence(environment.environmentId, status.status);
				} catch (cause) {
					if (!current()) return;
					const error = connectionErrorMessage(cause);
					if (
						error.startsWith("Could not authorize") ||
						error.startsWith("Could not verify") ||
						error.startsWith("Your sign-in expired")
					) {
						appAtomRegistry.set(personalEnvironmentsErrorAtom, error);
						return;
					}
					patchPresence(environment.environmentId, "offline");
				}
			}),
		);
	} catch (cause) {
		if (!current()) return;
		batchAtomUpdates(() => {
			appAtomRegistry.set(personalEnvironmentsLoadingAtom, false);
			appAtomRegistry.set(
				personalEnvironmentsErrorAtom,
				connectionErrorMessage(cause),
			);
		});
	} finally {
		if (request === refreshGeneration)
			appAtomRegistry.set(personalEnvironmentsLoadingAtom, false);
	}
};

/** Mint a connect token and register the connection; returns its key. */
export const connectToEnvironment = async (
	environmentId: string,
): Promise<string> => {
	const generation = cloudCatalogGeneration();
	if (appAtomRegistry.get(cloudCatalogAtom).scope.kind !== "personal")
		throw new Error("Select Personal to connect this computer.");
	const grant = await connectEnvironment(environmentId);
	if (generation !== cloudCatalogGeneration())
		throw new Error("Workspace changed. Reconnect from Personal.");
	const label =
		appAtomRegistry
			.get(personalEnvironmentsAtom)
			.find((e) => e.environmentId === environmentId)?.label ?? "Computer";
	const record = await addApiConnection({
		environmentId,
		label,
		wsBaseUrl: grant.endpoint.wsBaseUrl,
		token: grant.connectToken,
	});
	if (generation !== cloudCatalogGeneration())
		throw new Error("Workspace changed. Reconnect from Personal.");
	return record.key;
};

export const resetEnvironmentsRuntime = (): void => {
	refreshGeneration++;
	batchAtomUpdates(() => {
		appAtomRegistry.set(personalEnvironmentsAtom, []);
		appAtomRegistry.set(personalEnvironmentsLoadingAtom, false);
		appAtomRegistry.set(personalEnvironmentsErrorAtom, null);
	});
};
