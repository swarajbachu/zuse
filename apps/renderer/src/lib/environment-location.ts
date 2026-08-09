import type { EnvironmentCatalogEntry } from "../store/environment-catalog.ts";

export type EnvironmentLocation = {
	readonly isLocal: boolean;
	readonly label: string;
	readonly menuLabel: string;
};

export const deriveEnvironmentLocation = (input: {
	readonly activeEnvironmentId: string;
	readonly localEnvironmentId: string;
	readonly activeEntry: EnvironmentCatalogEntry | null;
}): EnvironmentLocation => {
	const isLocal =
		input.activeEnvironmentId === input.localEnvironmentId ||
		input.activeEntry?.connectionKind === "local";
	if (isLocal) {
		return { isLocal: true, label: "Local", menuLabel: "This Mac" };
	}

	const remoteLabel = input.activeEntry?.label.trim() || "Remote computer";
	return {
		isLocal: false,
		label: remoteLabel,
		menuLabel: remoteLabel,
	};
};
