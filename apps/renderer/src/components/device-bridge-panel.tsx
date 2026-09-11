import {
	DeviceBridgeController,
	EMPTY_DEVICE_BRIDGE_VIEW,
} from "@zuse/client-runtime/device-bridge-controller";
import { DEVICE_PERMISSION_DESCRIPTION } from "@zuse/client-runtime/device-permission-presentation";
import type { DeviceBridgeControl, DeviceBridgeResult } from "@zuse/contracts";
import { useEffect, useMemo, useState } from "react";
import { dispatchLocalDeviceCommand } from "../lib/local-device-client-bus.ts";
import { DeviceCommandCard } from "./device-command-card.tsx";
import { Button } from "./ui/button.tsx";

export const localDeviceBridge = (
	action: DeviceBridgeControl,
): Promise<DeviceBridgeResult> =>
	dispatchLocalDeviceCommand("deviceBridge.control", action);

/** Device access settings; command approvals are rendered only in their chat. */
export function DeviceBridgePanel() {
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
			aria-label="Cloud agent access"
			className="flex max-h-64 shrink-0 flex-col gap-2 overflow-y-auto rounded-md bg-muted/30 p-3 text-xs"
		>
			<div className="flex items-center justify-between gap-2">
				<span className="font-medium">Cloud agent access</span>
				<Button
					className="h-7"
					disabled={busy || !status?.connected}
					onClick={() =>
						void act({ _tag: "configure", enabled: !status?.enabled })
					}
				>
					{status?.enabled ? "Turn off" : "Enable"}
				</Button>
			</div>
			<p className="text-muted-foreground">
				{status?.connected
					? status.enabled
						? "Ready · Commands require device permission"
						: "Ready · Cloud agent access is off"
					: "Requires Zuse running, sign-in, and hosted device access."}
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
							? `Chat ${grant.chatId}`
							: "Always allow · Your cloud chats"}
					</span>
					<Button
						className="h-7"
						disabled={busy}
						onClick={() => void act({ _tag: "revoke", id: grant.id })}
					>
						Revoke
					</Button>
				</div>
			))}
		</section>
	);
}
