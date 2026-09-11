import {
	DeviceBridgeController,
	EMPTY_DEVICE_BRIDGE_VIEW,
} from "@zuse/client-runtime/device-bridge-controller";
import { DEVICE_PERMISSION_DESCRIPTION } from "@zuse/client-runtime/device-permission-presentation";
import type { DeviceBridgeControl, DeviceBridgeResult } from "@zuse/contracts";
import { useCallback, useEffect, useMemo, useState } from "react";
import { runControlPlane } from "../lib/control-plane-client.ts";
import { dispatchLocalDeviceCommand } from "../lib/local-device-client-bus.ts";
import { rendererPlatformCapabilities } from "../lib/platform-capabilities.ts";
import { DeviceCommandCard } from "./device-command-card.tsx";
import { Button } from "./ui/button.tsx";

export const localDeviceBridge = (
	action: DeviceBridgeControl,
): Promise<DeviceBridgeResult> =>
	dispatchLocalDeviceCommand("deviceBridge.control", action);

/** Shared presentation for desktop settings, desktop approval notifications, and cloud chats. */
export function DeviceBridgePanel({
	workspaceId,
	approvalsOnly = false,
}: {
	workspaceId?: string;
	approvalsOnly?: boolean;
}) {
	const [view, setView] = useState(EMPTY_DEVICE_BRIDGE_VIEW);
	const { status, error, busy } = view;
	const [showDetails, setShowDetails] = useState(false);
	const send = useCallback(
		(action: DeviceBridgeControl) => {
			if (!workspaceId) return localDeviceBridge(action);
			if (action._tag === "configure")
				return Promise.reject(new Error("Enable access on the target desktop"));
			return runControlPlane((client) =>
				client["deviceBridge.cloud"]({ workspaceId, action }),
			);
		},
		[workspaceId],
	);

	const controller = useMemo(() => new DeviceBridgeController(send), [send]);
	useEffect(() => controller.start(setView), [controller]);
	const act = (action: DeviceBridgeControl) => controller.act(action);
	const useThisComputer = () =>
		controller.run(async () => {
			if (!workspaceId) return;
			const local = await localDeviceBridge({ _tag: "status" });
			if (!("version" in local) || !local.connected)
				throw new Error("Enable hosted device access on this desktop first.");
			await runControlPlane((client) =>
				client["deviceBridge.cloud"]({
					workspaceId,
					action: { _tag: "status" },
					targetDeviceId: local.deviceId,
				}),
			);
		});
	const pending =
		status?.commands.filter((command) => command.state === "pending") ?? [];
	if (approvalsOnly && pending.length === 0) return null;
	const commands = approvalsOnly ? pending : (status?.commands ?? []);
	return (
		<section
			aria-label="Cloud agent access"
			aria-live={approvalsOnly ? "polite" : undefined}
			className={
				approvalsOnly
					? "fixed bottom-4 right-4 z-50 max-h-[70vh] w-[420px] max-w-[95vw] overflow-y-auto rounded-lg bg-background p-3 text-xs shadow-lg"
					: "flex max-h-64 shrink-0 flex-col gap-2 overflow-y-auto rounded-md bg-muted/30 p-3 text-xs"
			}
		>
			<div className="flex items-center justify-between gap-2">
				<span className="font-medium">
					{workspaceId
						? `Local computer${status ? ` · ${status.deviceName}` : ""}`
						: "Cloud agent access"}
				</span>
				{!approvalsOnly && !workspaceId && (
					<Button
						className="h-7"
						disabled={busy || !status?.connected}
						onClick={() =>
							void act({ _tag: "configure", enabled: !status?.enabled })
						}
					>
						{status?.enabled ? "Turn off" : "Enable"}
					</Button>
				)}
				{!approvalsOnly && workspaceId && (
					<Button
						className="h-7"
						onClick={() => setShowDetails((value) => !value)}
					>
						{showDetails ? "Hide activity" : "Activity"}
					</Button>
				)}
			</div>
			{!approvalsOnly && (
				<p className="text-muted-foreground">
					{status?.connected
						? status.enabled
							? "Ready · Commands require device permission"
							: "Ready · Cloud agent access is off"
						: "Requires Zuse running, sign-in, and hosted device access."}
				</p>
			)}
			{(!workspaceId || pending.length > 0) && (
				<p className="text-muted-foreground">{DEVICE_PERMISSION_DESCRIPTION}</p>
			)}
			{error && (
				<p role="alert" className="text-destructive">
					{error}
				</p>
			)}
			{!approvalsOnly &&
				workspaceId &&
				rendererPlatformCapabilities().networkLifecycle && (
					<Button
						className="h-7 self-start"
						disabled={busy}
						onClick={() => void useThisComputer()}
					>
						Use this desktop
					</Button>
				)}
			{commands
				.filter(
					(command) =>
						!workspaceId ||
						showDetails ||
						command.state === "pending" ||
						command.state === "running",
				)
				.map((command) => (
					<DeviceCommandCard
						key={command.id}
						command={command}
						busy={busy}
						onAction={act}
						showOutput={!approvalsOnly}
					/>
				))}
			{!approvalsOnly &&
				(!workspaceId || showDetails) &&
				status?.grants.map((grant) => (
					<div
						key={grant.id}
						className="flex items-center justify-between gap-2"
					>
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
