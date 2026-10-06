import "@zuse/i18n/english/chat";
import "@zuse/i18n/english/common";
import { cloudProviderAuthenticationMode } from "@zuse/client-runtime/cloud-provider-availability";
import type { EnvironmentId } from "@zuse/contracts";
import { useMessages as useUiMessages } from "@zuse/i18n/react";

import { useCloudChatCatalogStore } from "../lib/cloud-workspace-catalog.ts";
import type {
	ProviderErrorNotice,
	RateLimitInfo,
} from "../lib/provider-error-notice.ts";
import { providerDisplayName } from "../lib/provider-labels.ts";
import type { ChatError } from "../lib/session-actions.ts";

export interface ProviderErrorCopy {
	readonly title: string;
	readonly detail: string;
}

export const firstErrorLine = (message: string): string =>
	message.trim().split("\n", 1)[0] ?? "";

/**
 * Headline and one-line detail for a provider failure. Shared by the quiet
 * transcript row and the above-composer tray so both read the same.
 */
export function useProviderErrorCopy(
	environmentId: EnvironmentId | undefined,
): (notice: ProviderErrorNotice, error: ChatError) => ProviderErrorCopy {
	const { message: uiMessage } = useUiMessages(["chat", "common"]);
	const cloudSummary = useCloudChatCatalogStore((state) =>
		environmentId === undefined
			? null
			: (state.summaries.find(
					(summary) => summary.workspaceId === environmentId,
				) ?? null),
	);

	const resetDetail = (limit: RateLimitInfo): string => {
		if (limit.resetText !== undefined)
			return uiMessage("chat:message_row_limit_resets", {
				time: limit.resetText,
			});
		switch (limit.period) {
			case "weekly":
				return uiMessage("chat:message_row_weekly_limit");
			case "monthly":
				return uiMessage("chat:message_row_monthly_limit");
			case "daily":
				return uiMessage("chat:message_row_daily_limit");
			case undefined:
				return uiMessage("chat:message_row_try_again_later");
		}
	};

	return (notice, error) => {
		const detail = firstErrorLine(error.message);
		switch (notice.kind) {
			case "usage-limit":
				return {
					title: uiMessage("chat:message_row_limit_reached"),
					detail: resetDetail(notice.limit),
				};
			case "reconnecting":
				return {
					title: uiMessage("chat:message_row_reconnecting"),
					detail: `${notice.attempt}/${notice.maxAttempts}`,
				};
			case "gemini-upgrade":
				return {
					title: uiMessage("chat:message_row_gemini_cli_needs_an_upgrade"),
					detail: uiMessage(
						"chat:message_row_your_installed_gemini_cli_does_not_support_acp_mode_yet_so_zuse_zuse_b",
					),
				};
			case "cloud-auth": {
				const providerLabel = String(providerDisplayName(notice.providerId));
				const mode = cloudProviderAuthenticationMode(
					notice.providerId,
					cloudSummary,
				);
				return mode === "legacy-image"
					? {
							title: uiMessage(
								"chat:message_row_this_cloud_chat_uses_legacy_authentication",
								{ providerLabel },
							),
							detail: uiMessage(
								"chat:message_row_its_image_owned_credential_cannot_be_migrated_safely_reconnect_on",
								{ providerLabel },
							),
						}
					: mode === "broker-v1"
						? {
								title: uiMessage(
									"chat:message_row_account_needs_reconnecting",
									{ providerLabel },
								),
								detail: uiMessage(
									"chat:message_row_reconnect_once_in_cloud_workspace_settings_the_account_credential",
									{ providerLabel },
								),
							}
						: {
								title: uiMessage(
									"chat:message_row_authentication_is_unavailable",
									{ providerLabel },
								),
								detail: uiMessage(
									"chat:message_row_open_cloud_workspace_settings_to_restore_account_level_authentica",
									{ providerLabel },
								),
							};
			}
			case "sign-in":
				return {
					title: uiMessage("chat:message_row_signed_out_of", {
						label: providerDisplayName(notice.providerId),
					}),
					detail: "",
				};
			case "auth":
				return {
					title:
						notice.providerId === undefined
							? uiMessage("chat:message_row_sign_in_required")
							: uiMessage("chat:message_row_sign_in_to_provider", {
									label: providerDisplayName(notice.providerId),
								}),
					detail,
				};
			case "network":
				return { title: uiMessage("chat:message_row_connection_lost"), detail };
			case "terminal":
				return { title: notice.headline, detail };
			case "generic":
				return { title: uiMessage("chat:message_row_provider_error"), detail };
		}
	};
}
