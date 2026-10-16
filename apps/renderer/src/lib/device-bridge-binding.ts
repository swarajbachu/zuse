import type {
	DeviceBridgeControl,
	DeviceBridgeResult,
	DeviceBridgeStatus,
} from "@zuse/contracts";

import { runControlPlane } from "./control-plane-client.ts";
import { recordDiagnosticEvent } from "./diagnostics-recorder.ts";
import { dispatchLocalDeviceCommand } from "./local-device-client-bus.ts";
import { rendererPlatformCapabilities } from "./platform-capabilities.ts";

const LOCAL_DEVICE_READY_TIMEOUT_MS = 30_000;
const LOCAL_DEVICE_RETRY_MS = 500;

let pendingLocalDevice: Promise<DeviceBridgeStatus | null> | undefined;

export const localDeviceBridge = (
	action: DeviceBridgeControl,
): Promise<DeviceBridgeResult> =>
	dispatchLocalDeviceCommand("deviceBridge.control", action);

export const commandEnabledLocalDevice =
	async (): Promise<DeviceBridgeStatus | null> => {
		if (!rendererPlatformCapabilities().desktop) return null;
		if (pendingLocalDevice !== undefined) return pendingLocalDevice;
		const waitForDevice = async (): Promise<DeviceBridgeStatus | null> => {
			const deadline = Date.now() + LOCAL_DEVICE_READY_TIMEOUT_MS;
			while (Date.now() < deadline) {
				let timer: ReturnType<typeof setTimeout> | undefined;
				let result: DeviceBridgeResult | null;
				try {
					result = await Promise.race([
						localDeviceBridge({ _tag: "status" }).catch(() => null),
						new Promise<null>((resolve) => {
							timer = setTimeout(() => resolve(null), deadline - Date.now());
						}),
					]);
				} finally {
					clearTimeout(timer);
				}
				if (result !== null && "version" in result && result.connected)
					return result.enabled ? result : null;
				const remaining = deadline - Date.now();
				if (remaining <= 0) return null;
				await new Promise<void>((resolve) =>
					setTimeout(resolve, Math.min(LOCAL_DEVICE_RETRY_MS, remaining)),
				);
			}
			return null;
		};
		pendingLocalDevice = waitForDevice().finally(() => {
			pendingLocalDevice = undefined;
		});
		return pendingLocalDevice;
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
	let timer: ReturnType<typeof setTimeout> | undefined;
	const bind = async () => {
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
	try {
		return await Promise.race([
			bind(),
			new Promise<boolean>((resolve) => {
				timer = setTimeout(() => resolve(false), 500);
			}),
		]);
	} finally {
		clearTimeout(timer);
	}
};
