import "@zuse/i18n/english/shell";
import { message as uiMessage } from "@zuse/i18n";
import type { EnvironmentCatalogEntry } from "../store/environment-catalog.ts";

export type EnvironmentLocation = {
	readonly isLocal: boolean;
	/** Whether the remote connection is live; always true for this computer. */
	readonly connected: boolean;
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
		return {
			isLocal: true,
			connected: true,
			label: uiMessage("shell:environment_location_local"),
			menuLabel: "This Mac",
		};
	}

	const remoteLabel = input.activeEntry?.label.trim() || "Remote computer";
	return {
		isLocal: false,
		connected: input.activeEntry?.status === "connected",
		label: remoteLabel,
		menuLabel: remoteLabel,
	};
};
