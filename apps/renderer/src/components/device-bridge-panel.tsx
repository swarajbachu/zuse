import "@zuse/i18n/english/chat";
import {
	DeviceBridgeController,
	EMPTY_DEVICE_BRIDGE_VIEW,
} from "@zuse/client-runtime/device-bridge-controller";
import { DEVICE_PERMISSION_DESCRIPTION } from "@zuse/client-runtime/device-permission-presentation";
import type { DeviceBridgeControl } from "@zuse/contracts";
import { useMessages as useUiMessages } from "@zuse/i18n/react";
import { useEffect, useMemo, useState } from "react";
import { localDeviceBridge } from "../lib/device-bridge-binding.ts";
import { DeviceCommandCard } from "./device-command-card.tsx";
import { Button } from "./ui/button.tsx";

/** Device access settings; command approvals are rendered only in their chat. */
export function DeviceBridgePanel() {
	const { message: uiMessage } = useUiMessages(["chat"]);

	const [view, setView] = useState(EMPTY_DEVICE_BRIDGE_VIEW);
	const { status, error, busy } = view;
	const controller = useMemo(
		() => new DeviceBridgeController(localDeviceBridge),
		[],
	);
	useEffect(() => controller.start(setView), [controller]);
	const act = (action: DeviceBridgeControl) => controller.act(action);
	return (
		<section
			aria-label={uiMessage("chat:device_bridge_panel_cloud_agent_access")}
			className="flex max-h-64 shrink-0 flex-col gap-2 overflow-y-auto rounded-md bg-muted/30 p-3 text-xs"
		>
			<div className="flex items-center justify-between gap-2">
				<span className="font-medium">
					{uiMessage("chat:device_bridge_panel_cloud_agent_access")}
				</span>
				<Button
					className="h-7"
					disabled={busy || !status?.connected}
					onClick={() =>
						void act({ _tag: "configure", enabled: !status?.enabled })
					}
				>
					{status?.enabled
						? uiMessage("chat:device_bridge_panel_turn_off")
						: uiMessage("chat:device_bridge_panel_enable")}
				</Button>
			</div>
			<p className="text-muted-foreground">
				{status?.connected
					? status.enabled
						? uiMessage(
								"chat:device_bridge_panel_ready_commands_require_device_permission",
							)
						: uiMessage(
								"chat:device_bridge_panel_ready_cloud_agent_access_is_off",
							)
					: uiMessage(
							"chat:device_bridge_panel_requires_zuse_running_sign_in_and_hosted_device_access",
						)}
			</p>
			<p className="text-muted-foreground">{DEVICE_PERMISSION_DESCRIPTION}</p>
			{error && (
				<p role="alert" className="text-destructive">
					{error}
				</p>
			)}
			{status?.commands.map((command) => (
				<DeviceCommandCard
					key={command.id}
					command={command}
					busy={busy}
					onAction={act}
				/>
			))}
			{status?.grants.map((grant) => (
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
