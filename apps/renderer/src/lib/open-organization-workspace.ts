import type { Organization } from "@zuse/contracts";
import { useUiStore } from "../store/ui.ts";
import { selectRendererWorkspace } from "./renderer-workspace.ts";

/**
 * Switches to an organization's workspace. Billing-only members always land on
 * Billing; `settings` opens Members for everyone else (after create or join).
 */
export const openOrganizationWorkspace = (
	organization: Pick<Organization, "id" | "role">,
	options: { readonly settings?: boolean } = {},
): void => {
	selectRendererWorkspace({
		kind: "organization",
		organizationId: organization.id,
	});
	const ui = useUiStore.getState();
	if (organization.role === "billing")
		ui.setSettingsSection({ kind: "cloud", page: "billing" });
	else if (options.settings) ui.setSettingsSection({ kind: "organizations" });
	else return;
	ui.setView("settings");
};
