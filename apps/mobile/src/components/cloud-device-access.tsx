import {
	DeviceBridgeCatalogController,
	EMPTY_BRIDGE_CATALOG,
} from "@zuse/client-runtime/device-bridge-catalog";
import {
	DeviceBridgeController,
	EMPTY_DEVICE_BRIDGE_VIEW,
} from "@zuse/client-runtime/device-bridge-controller";
import {
	DEVICE_PERMISSION_CHOICES,
	DEVICE_PERMISSION_DESCRIPTION,
} from "@zuse/client-runtime/device-permission-presentation";
import type { DeviceBridgeAction } from "@zuse/contracts";
import { Effect } from "effect";
import { useEffect, useMemo, useState } from "react";
import { Text, View } from "react-native";
import { Button } from "~/components/ui/button";
import { cloudControlClient } from "~/rpc/api-client";

export function CloudDeviceAccess({ workspaceId }: { workspaceId: string }) {
	const [view, setView] = useState(EMPTY_DEVICE_BRIDGE_VIEW);
	const [catalog, setCatalog] = useState(EMPTY_BRIDGE_CATALOG);
	const catalogController = useMemo(
		() =>
			new DeviceBridgeCatalogController({
				list: () =>
					Effect.runPromise(cloudControlClient["deviceBridge.devices"]({})),
				status: () =>
					Effect.runPromise(
						cloudControlClient["deviceBridge.cloud"]({
							workspaceId,
							action: { _tag: "status" },
						}),
					),
				select: (targetDeviceId) =>
					Effect.runPromise(
						cloudControlClient["deviceBridge.cloud"]({
							workspaceId,
							targetDeviceId,
							action: { _tag: "status" },
						}),
					),
			}),
		[workspaceId],
	);
	useEffect(() => catalogController.start(setCatalog), [catalogController]);
	const { status, error, busy } = view;
	const controller = useMemo(
		() =>
			new DeviceBridgeController((action) => {
				return Effect.runPromise(
					cloudControlClient["deviceBridge.cloud"]({ workspaceId, action }),
				);
			}),
		[workspaceId],
	);
	useEffect(() => controller.start(setView), [controller]);
	const act = (action: DeviceBridgeAction) => controller.act(action);

	const commands =
		status?.commands.filter(
			(command) => command.state === "pending" || command.state === "running",
		) ?? [];

	return (
		<View className="gap-2 p-3">
			<Text className="font-sans text-xs text-muted-foreground">
				Cloud device · Commands require approval
			</Text>
			<View className="flex-row flex-wrap gap-1">
				{catalog.devices.map((device) => (
					<Button
						key={device.deviceId}
						size="sm"
						disabled={catalog.busy || device.revoked}
						onPress={() => void catalogController.select(device.deviceId)}
					>
						{device.label}
						{catalog.selected === device.deviceId ? " · Selected" : ""}
						{device.connected ? "" : " · Not connected"}
					</Button>
				))}
			</View>
			{catalog.error && (
				<Text role="alert" className="text-xs text-danger">
					{catalog.error}
				</Text>
			)}
			<Text className="font-sans text-sm text-foreground">
				Local computer · {status?.deviceName ?? "No computer selected"}
				{status?.enabled ? "" : " · Access off"}
			</Text>
			{commands.some((command) => command.state === "pending") && (
				<Text className="font-sans text-xs text-muted-foreground">
					{DEVICE_PERMISSION_DESCRIPTION}
				</Text>
			)}
			{error && (
				<Text role="alert" className="font-sans text-xs text-danger">
					{error}
				</Text>
			)}
			{commands.map((command) => (
				<View key={command.id} className="gap-2">
					<Text className="font-sans text-xs text-foreground">
						{command.chatTitle} · {command.state}
					</Text>
					<Text selectable className="font-mono text-xs text-foreground">
						{command.cwd}
						{"\n"}
						{command.command}
					</Text>
					<View className="flex-row flex-wrap gap-1">
						{command.state === "pending" ? (
							DEVICE_PERMISSION_CHOICES.map(([decision, label]) => (
								<Button
									key={decision}
									size="sm"
									disabled={busy}
									onPress={() =>
										void act({ _tag: "decide", id: command.id, decision })
									}
								>
									{label}
								</Button>
							))
						) : (
							<Button
								size="sm"
								disabled={busy}
								onPress={() => void act({ _tag: "cancel", id: command.id })}
							>
								Stop
							</Button>
						)}
					</View>
				</View>
			))}
			{status?.grants.map((grant) => (
				<Button
					key={grant.id}
					size="sm"
					className="self-start"
					disabled={busy}
					onPress={() => void act({ _tag: "revoke", id: grant.id })}
				>
					{grant.chatId ? "Revoke Chat Access" : "Revoke Always Allow"}
				</Button>
			))}
		</View>
	);
}
