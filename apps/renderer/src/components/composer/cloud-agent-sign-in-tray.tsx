import "@zuse/i18n/english/chat";
import "@zuse/i18n/english/common";
import { HugeiconsIcon } from "@hugeicons/react";
import { useMessages as useUiMessages } from "@zuse/i18n/react";
import { Alert02Icon, Logout03Icon } from "@zuse/icons/stroke-rounded";

import type { cloudSendBlocker } from "../../lib/model-picker-availability.ts";
import { TrayPill, trayPillTextActionClass } from "./tray-pill.tsx";

/**
 * Above-composer notice for a cloud draft that can't be sent: either the cloud
 * agent sign-in check failed or no agent is connected for cloud workspaces.
 * Sits with the offline and provider sign-in trays so every reason Send is
 * blocked shows up in the same place.
 */
export function CloudAgentSignInTray({
	blocker,
	onRetry,
	onOpenSettings,
}: {
	readonly blocker: NonNullable<ReturnType<typeof cloudSendBlocker>>;
	readonly onRetry: () => void;
	readonly onOpenSettings: () => void;
}) {
	const { message: uiMessage } = useUiMessages(["chat", "common"]);
	const failed = blocker === "auth-check-failed";
	return (
		<TrayPill
			flush
			role="status"
			aria-live="polite"
			icon={
				<HugeiconsIcon
					icon={failed ? Alert02Icon : Logout03Icon}
					className="size-3.5"
				/>
			}
			title={
				failed
					? uiMessage("chat:chat_landing_cloud_auth_check_failed")
					: uiMessage("chat:chat_landing_cloud_auth_no_agents")
			}
			subtitle={
				failed
					? uiMessage("chat:chat_landing_cloud_auth_check_failed_hint")
					: uiMessage("chat:chat_landing_cloud_auth_no_agents_hint")
			}
			actions={
				<>
					{failed ? (
						<button
							type="button"
							className={trayPillTextActionClass}
							onClick={onRetry}
						>
							{uiMessage("common:retry")}
						</button>
					) : null}
					<button
						type="button"
						className={trayPillTextActionClass}
						onClick={onOpenSettings}
					>
						{failed
							? uiMessage("common:settings")
							: uiMessage("chat:chat_landing_cloud_auth_connect_agent")}
					</button>
				</>
			}
		/>
	);
}
