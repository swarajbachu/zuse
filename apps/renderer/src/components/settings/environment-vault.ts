import type {
	EnvironmentEntry,
	EnvironmentVaultCommand,
} from "@zuse/contracts";
import { runControlPlane } from "../../lib/control-plane-client.ts";

/** Shared client helpers for the account Environment pane and repository panel. */
export const callEnvironmentVault = (input: EnvironmentVaultCommand) =>
	runControlPlane((client) => client["environment.vault"](input));

export const blankEnvironmentEntry = (
	overrides: Partial<EnvironmentEntry> = {},
): EnvironmentEntry => ({
	id: "",
	name: "",
	kind: "secret",
	scope: "personal",
	projectIds: null,
	excludedProjectIds: [],
	target: "both",
	revision: 0,
	updatedAt: 0,
	...overrides,
});

export const ENVIRONMENT_TARGET_LABEL: Record<
	EnvironmentEntry["target"],
	string
> = {
	both: "Local and cloud",
	local: "Local only",
	cloud: "Cloud only",
};

export const environmentVaultFailure = (cause: unknown) => {
	const code =
		typeof cause === "object" && cause !== null && "code" in cause
			? String(cause.code)
			: "";
	if (code === "conflict")
		return "These settings changed elsewhere. Refresh before saving again.";
	if (code === "not-allowed")
		return "Sign in with an account that has access to these settings.";
	if (code === "invalid-request")
		return "Check the name and project assignments. Duplicate assignments and reserved names are not allowed.";
	return "Could not sync environment settings. Check your connection and retry.";
};
