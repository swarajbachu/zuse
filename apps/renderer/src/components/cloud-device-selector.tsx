import "@zuse/i18n/english/settings";
import {
	DeviceBridgeCatalogController,
	EMPTY_BRIDGE_CATALOG,
} from "@zuse/client-runtime/device-bridge-catalog";
import { useMessages as useUiMessages } from "@zuse/i18n/react";
import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { runCloudControl } from "../lib/control-plane-client.ts";
import {
	rendererAccountSnapshot,
	subscribeRendererAccount,
} from "../lib/renderer-account.ts";

/** Cloud command targets are never populated from the remote-computer catalog. */
export function CloudDeviceSelector({ workspaceId }: { workspaceId: string }) {
	const { message: uiMessage } = useUiMessages(["settings"]);
	const account = useSyncExternalStore(
		subscribeRendererAccount,
		rendererAccountSnapshot,
	);
	const [view, setView] = useState(EMPTY_BRIDGE_CATALOG);
	const { devices, selected, error, busy } = view;
	const controller = useMemo(
		() =>
			new DeviceBridgeCatalogController({
				list: () => {
					if (rendererAccountSnapshot() !== account)
						return Promise.reject(new Error("Account changed"));
					return runCloudControl((client) =>
						client["deviceBridge.devices"]({}),
					);
				},
				status: () =>
					runCloudControl((client) =>
						client["deviceBridge.cloud"]({
							workspaceId,
							action: { _tag: "status" },
						}),
					),
				select: (targetDeviceId) =>
					runCloudControl((client) =>
						client["deviceBridge.cloud"]({
							workspaceId,
							targetDeviceId,
							action: { _tag: "status" },
						}),
					),
			}),
		[workspaceId, account],
	);
	useEffect(() => controller.start(setView), [controller]);
	return (
		<div className="flex min-w-0 flex-wrap items-center gap-2 text-xs">
			<label
				htmlFor={`cloud-device-${workspaceId}`}
				className="text-muted-foreground"
			>
				{uiMessage("settings:cloud_device_label")}
			</label>
			<select
				id={`cloud-device-${workspaceId}`}
				className="h-7 min-w-0 max-w-full rounded-md bg-muted px-2"
				disabled={busy}
				value={selected}
				onChange={(event) => {
					const id = event.target.value;
					if (!id) return;
					void controller.select(id);
				}}
			>
				<option value="">{uiMessage("settings:cloud_device_choose")}</option>
				{devices.map((device) => (
					<option
						key={device.deviceId}
						value={device.deviceId}
						disabled={device.revoked}
					>
						{device.label} ·{" "}
						{device.revoked
							? uiMessage("settings:cloud_device_revoked")
							: device.connected
								? uiMessage("settings:cloud_device_ready")
								: uiMessage("settings:cloud_device_not_connected")}
					</option>
				))}
			</select>
			{error && (
				<span role="alert" className="text-destructive">
					{error}
				</span>
			)}
		</div>
	);
}
