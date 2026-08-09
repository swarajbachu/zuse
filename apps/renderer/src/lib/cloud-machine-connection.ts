import type { CatalogConnectionStatus } from "../store/environment-catalog.ts";

export type CloudConnectionPresentation = Readonly<{
	description: string;
	label: string;
	variant: "success" | "info" | "warning" | "error";
}>;

export const cloudConnectionPresentation = (
	status: CatalogConnectionStatus | undefined,
	error?: string | null,
): CloudConnectionPresentation => {
	if (status === "connected") {
		return {
			description: "Securely connected. Projects and terminals are available.",
			label: "Connected",
			variant: "success",
		};
	}
	if (status === "error") {
		return {
			description: error ?? "The secure connection needs to be retried.",
			label: "Connection failed",
			variant: "error",
		};
	}
	if (status === "offline") {
		return {
			description: error ?? "The machine is not responding right now.",
			label: "Offline",
			variant: "warning",
		};
	}
	if (status === "connecting") {
		return {
			description: "Establishing the secure desktop connection.",
			label: "Connecting",
			variant: "info",
		};
	}
	return {
		description:
			"The machine is ready, but it has not been connected to this desktop yet.",
		label: "Not connected",
		variant: "warning",
	};
};
