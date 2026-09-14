import type {
	DeviceBridgeControl,
	DeviceBridgeResult,
	DeviceBridgeStatus,
} from "@zuse/contracts";

import { runControlPlane } from "./control-plane-client.ts";
import { recordDiagnosticEvent } from "./diagnostics-recorder.ts";
import { dispatchLocalDeviceCommand } from "./local-device-client-bus.ts";
import { rendererPlatformCapabilities } from "./platform-capabilities.ts";

const LOCAL_DEVICE_STATUS_TIMEOUT_MS = 500;

export const localDeviceBridge = (
	action: DeviceBridgeControl,
): Promise<DeviceBridgeResult> =>
	dispatchLocalDeviceCommand("deviceBridge.control", action);

export const commandEnabledLocalDevice =
	async (): Promise<DeviceBridgeStatus | null> => {
		if (!rendererPlatformCapabilities().desktop) return null;
		const result = await Promise.race([
			localDeviceBridge({ _tag: "status" }).catch(() => null),
			new Promise<null>((resolve) =>
				setTimeout(() => resolve(null), LOCAL_DEVICE_STATUS_TIMEOUT_MS),
			),
		]);
		return result !== null &&
			"version" in result &&
			result.connected &&
			result.enabled
			? result
			: null;
	};

type CloudDeviceBindingDependencies = {
	readonly availableDevice: () => Promise<DeviceBridgeStatus | null>;
	readonly bindDevice: (
		workspaceId: string,
		deviceId: string,
	) => Promise<unknown>;
};

const defaultBindingDependencies: CloudDeviceBindingDependencies = {
	availableDevice: commandEnabledLocalDevice,
	bindDevice: (workspaceId, targetDeviceId) =>
		runControlPlane((client) =>
			client["deviceBridge.cloud"]({
				workspaceId,
				action: { _tag: "status" },
				targetDeviceId,
			}),
		),
};

/**
 * Makes the desktop sending the next message the cloud workspace's command
 * target. Binding is best-effort so device access never prevents chat delivery.
 */
export const bindCloudWorkspaceToLocalDevice = async (
	workspaceId: string,
	dependencies: CloudDeviceBindingDependencies = defaultBindingDependencies,
): Promise<boolean> => {
	try {
		const device = await dependencies.availableDevice();
		if (device === null) return false;
		await dependencies.bindDevice(workspaceId, device.deviceId);
		return true;
	} catch (cause) {
		recordDiagnosticEvent({
			level: "warn",
			source: "renderer.device-bridge-binding",
			message: "Cloud workspace device binding failed",
			detail: cause instanceof Error ? cause.name : typeof cause,
		});
		return false;
	}
};
