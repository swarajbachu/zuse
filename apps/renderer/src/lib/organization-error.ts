import "@zuse/i18n/english/settings";
import { ORGANIZATION_MEMBER_LIMIT } from "@zuse/contracts";
import { message as uiMessage } from "@zuse/i18n";

export const organizationErrorMessage = (error: unknown): string => {
	const code =
		error !== null && typeof error === "object" && "code" in error
			? error.code
			: null;
	if (code === "not-allowed")
		return uiMessage("settings:organizations_access_changed");
	if (code === "organization-limit-reached")
		return uiMessage("settings:organizations_creation_limit");
	if (code === "organization-member-limit-reached")
		return uiMessage("settings:organizations_member_limit", {
			limit: ORGANIZATION_MEMBER_LIMIT,
		});
	if (code === "conflict") return uiMessage("settings:organizations_conflict");
	if (code === "invalid-request")
		return uiMessage("settings:organizations_invalid");
	if (code === "not-found")
		return uiMessage("settings:organizations_not_found");
	return uiMessage("settings:organizations_unavailable");
};
