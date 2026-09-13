import {
	DeviceBridgeController,
	EMPTY_DEVICE_BRIDGE_VIEW,
} from "@zuse/client-runtime/device-bridge-controller";
import type {
	DeviceBridgeControl,
	DeviceBridgeStatus,
	PermissionDecision,
} from "@zuse/contracts";
import { useCallback, useEffect, useMemo, useState } from "react";
import { runControlPlane } from "./control-plane-client.ts";

export const pendingChatDeviceCommands = (
	status: DeviceBridgeStatus | null,
	workspaceId: string | undefined,
	chatId: string | null,
) =>
	status?.commands.filter(
		(command) =>
			command.state === "pending" &&
			command.workspaceId === workspaceId &&
			command.chatId === chatId,
	) ?? [];

/** Device approvals belong to their originating cloud chat, on every authenticated client. */
export function useChatDeviceApproval(
	workspaceId: string | undefined,
	chatId: string | null,
) {
	const [view, setView] = useState(EMPTY_DEVICE_BRIDGE_VIEW);
	const send = useCallback(
		(action: DeviceBridgeControl) => {
			if (!workspaceId || action._tag === "configure")
				return Promise.reject(new Error("No cloud chat selected"));
			return runControlPlane((client) =>
				client["deviceBridge.cloud"]({ workspaceId, action }),
			);
		},
		[workspaceId],
	);
	const controller = useMemo(() => new DeviceBridgeController(send), [send]);
	useEffect(() => {
		setView(EMPTY_DEVICE_BRIDGE_VIEW);
		if (workspaceId) return controller.start(setView);
	}, [controller, workspaceId]);
	const decide = useCallback(
		async (id: string, decision: PermissionDecision) => {
			await send({ _tag: "decide", id, decision: decision._tag });
			await controller.act({ _tag: "status" });
		},
		[controller, send],
	);
	return {
		commands: pendingChatDeviceCommands(view.status, workspaceId, chatId),
		decide,
	};
}
