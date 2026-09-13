import "@zuse/i18n/english/connections";
import { message as uiMessage } from "@zuse/i18n";
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
			description: uiMessage(
				"connections:cloud_machine_connection_securely_connected_projects_and_terminals_are_available",
			),
			label: uiMessage("connections:cloud_machine_connection_connected"),
			variant: "success",
		};
	}
	if (status === "error") {
		return {
			description: error ?? "The secure connection needs to be retried.",
			label: uiMessage(
				"connections:cloud_machine_connection_connection_failed",
			),
			variant: "error",
		};
	}
	if (status === "offline") {
		return {
			description: error ?? "The machine is not responding right now.",
			label: uiMessage("connections:cloud_machine_connection_offline"),
			variant: "warning",
		};
	}
	if (status === "connecting") {
		return {
			description: uiMessage(
				"connections:cloud_machine_connection_establishing_the_secure_desktop_connection",
			),
			label: uiMessage("connections:cloud_machine_connection_connecting"),
			variant: "info",
		};
	}
	return {
		description: uiMessage(
			"connections:cloud_machine_connection_the_machine_is_ready_but_it_has_not_been_connected_to_this_deskto",
		),
		label: uiMessage("connections:cloud_machine_connection_not_connected"),
		variant: "warning",
	};
};
