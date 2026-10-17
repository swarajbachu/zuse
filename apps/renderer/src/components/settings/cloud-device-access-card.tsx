import "@zuse/i18n/english/settings";
import {
	DeviceBridgeController,
	EMPTY_DEVICE_BRIDGE_VIEW,
} from "@zuse/client-runtime/device-bridge-controller";
import { useMessages as useUiMessages } from "@zuse/i18n/react";
import { useEffect, useMemo, useState } from "react";
import { localDeviceBridge } from "../../lib/device-bridge-binding.ts";
import { dispatchLocalDeviceCommand } from "../../lib/local-device-client-bus.ts";
import { DeviceCommandPermissions } from "../device-command-permissions.tsx";
import { Button } from "../ui/button.tsx";

export function CloudDeviceAccessCard() {
	const { message: uiMessage } = useUiMessages(["settings"]);
	const [view, setView] = useState(EMPTY_DEVICE_BRIDGE_VIEW);
	const controller = useMemo(
		() => new DeviceBridgeController(localDeviceBridge),
		[],
	);
	useEffect(() => controller.start(setView), [controller]);
	return (
		<section
			aria-label={uiMessage("settings:cloud_device_access_title")}
			className="min-w-0 space-y-2 rounded-md bg-muted/30 p-3 text-xs"
		>
			<div className="flex items-center justify-between gap-3">
				<div className="min-w-0 space-y-1">
					<h3 className="font-medium">
						{uiMessage("settings:cloud_device_access_title")}
					</h3>
					<p className="text-muted-foreground">
						{uiMessage("settings:cloud_device_access_help")}
					</p>
				</div>
				<Button
					className="h-7"
					variant="outline"
					disabled={view.busy || !view.status}
					onClick={() =>
						void controller.run(() =>
							dispatchLocalDeviceCommand("deviceBridge.setEnabled", {
								enabled: !view.status?.enabled,
							}),
						)
					}
				>
					{view.busy
						? uiMessage("settings:cloud_device_updating")
						: view.status?.enabled
							? uiMessage("settings:cloud_device_turn_off")
							: uiMessage("settings:cloud_device_enable")}
				</Button>
			</div>
			<p className="text-muted-foreground" role="status">
				{view.error ??
					view.status?.connectionError ??
					(view.status?.connected
						? uiMessage("settings:cloud_device_connected")
						: view.status?.enabled
							? uiMessage("settings:cloud_device_waiting")
							: uiMessage("settings:cloud_device_off"))}
			</p>
			<p className="text-[11px] text-muted-foreground">
				{uiMessage("settings:cloud_device_independent")}
			</p>
			{view.status?.enabled && !view.status.connected && (
				<Button
					className="h-7"
					variant="ghost"
					disabled={view.busy}
					onClick={() =>
						void controller.run(() =>
							dispatchLocalDeviceCommand("deviceBridge.setEnabled", {
								enabled: true,
							}),
						)
					}
				>
					{uiMessage("settings:cloud_device_reconnect")}
				</Button>
			)}
			<DeviceCommandPermissions
				view={view}
				act={(action) => controller.act(action)}
			/>
		</section>
	);
}
