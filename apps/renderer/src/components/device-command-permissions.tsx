import "@zuse/i18n/english/chat";
import type { DeviceBridgeView } from "@zuse/client-runtime/device-bridge-controller";
import type { DeviceBridgeControl } from "@zuse/contracts";
import { useMessages as useUiMessages } from "@zuse/i18n/react";
import { Button } from "./ui/button.tsx";

/** Saved command permissions remain revocable; commands and approvals live in chat. */
export function DeviceCommandPermissions({
	view,
	act,
}: {
	view: DeviceBridgeView;
	act: (action: DeviceBridgeControl) => Promise<void>;
}) {
	const { message: uiMessage } = useUiMessages(["chat"]);

	const { status, error, busy } = view;
	if (!status?.grants.length) return null;
	return (
		<section
			aria-label={uiMessage("chat:device_command_permissions_title")}
			className="flex max-h-64 shrink-0 flex-col gap-2 overflow-y-auto rounded-md bg-muted/30 p-3 text-xs"
		>
			<h3 className="font-medium">
				{uiMessage("chat:device_command_permissions_title")}
			</h3>
			{error && (
				<p role="alert" className="text-destructive">
					{error}
				</p>
			)}
			{status.grants.map((grant) => (
				<div key={grant.id} className="flex items-center justify-between gap-2">
					<span>
						{grant.chatId
							? uiMessage("chat:device_bridge_panel_chat", {
									value1: String(grant.chatId),
								})
							: uiMessage(
									"chat:device_bridge_panel_always_allow_your_cloud_chats",
								)}
					</span>
					<Button
						className="h-7"
						disabled={busy}
						onClick={() => void act({ _tag: "revoke", id: grant.id })}
					>
						{uiMessage("chat:device_bridge_panel_revoke")}
					</Button>
				</div>
			))}
		</section>
	);
}
