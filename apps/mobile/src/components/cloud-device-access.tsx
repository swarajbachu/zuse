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
	const { status, error, busy } = view;
	const controller = useMemo(
		() =>
			new DeviceBridgeController((action) => {
				if (action._tag === "configure")
					return Promise.reject(
						new Error("Enable access on the target desktop"),
					);
				return Effect.runPromise(
					cloudControlClient["deviceBridge.cloud"]({ workspaceId, action }),
				);
			}),
		[workspaceId],
	);
	useEffect(() => controller.start(setView), [controller]);
	const act = (action: DeviceBridgeAction) => controller.act(action);
	if (!status) return null;
	const commands = status.commands.filter(
		(command) => command.state === "pending" || command.state === "running",
	);
	if (commands.length === 0) return null;
	return (
		<View className="gap-2 p-3">
			<Text className="font-sans text-sm text-foreground">
				Local computer · {status.deviceName}
				{status.enabled ? "" : " · Access off"}
			</Text>
			{commands.some((command) => command.state === "pending") && (
				<Text className="font-sans text-xs text-muted-foreground">
					{DEVICE_PERMISSION_DESCRIPTION}
				</Text>
			)}
			{error && (
				<Text role="alert" className="font-sans text-xs text-destructive">
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
									className="h-7"
									disabled={busy}
									onPress={() =>
										void act({ _tag: "decide", id: command.id, decision })
									}
								>
									<Text className="text-xs">{label}</Text>
								</Button>
							))
						) : (
							<Button
								className="h-7"
								disabled={busy}
								onPress={() => void act({ _tag: "cancel", id: command.id })}
							>
								<Text className="text-xs">Stop command</Text>
							</Button>
						)}
					</View>
				</View>
			))}
			{status.grants.map((grant) => (
				<Button
					key={grant.id}
					className="h-7 self-start"
					disabled={busy}
					onPress={() => void act({ _tag: "revoke", id: grant.id })}
				>
					<Text className="text-xs">
						Revoke {grant.chatId ? "session access" : "always allow"}
					</Text>
				</Button>
			))}
		</View>
	);
}
