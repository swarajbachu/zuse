import {
	DEVICE_BRIDGE_VERSION,
	type DeviceBridgeStatus,
} from "@zuse/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";

const bridgeFakes = vi.hoisted(() => ({
	desktop: true,
	localCommand: vi.fn(),
	cloudCommand: vi.fn(),
}));

vi.mock("../../src/lib/platform-capabilities.ts", () => ({
	rendererPlatformCapabilities: () => ({ desktop: bridgeFakes.desktop }),
}));

vi.mock("../../src/lib/local-device-client-bus.ts", () => ({
	dispatchLocalDeviceCommand: bridgeFakes.localCommand,
}));

vi.mock("../../src/lib/control-plane-client.ts", () => ({
	runControlPlane: async (useClient: (client: unknown) => unknown) =>
		useClient({ "deviceBridge.cloud": bridgeFakes.cloudCommand }),
}));

import { bindCloudWorkspaceToLocalDevice } from "../../src/lib/device-bridge-binding.ts";

const connectedDevice = (deviceId = "mac-one"): DeviceBridgeStatus => ({
	version: DEVICE_BRIDGE_VERSION,
	enabled: true,
	connected: true,
	deviceId,
	deviceName: "Swaraj's Mac",
	homeDirectory: "/Users/swaraj",
	commands: [],
	grants: [],
});

describe("cloud device binding", () => {
	afterEach(() => {
		bridgeFakes.desktop = true;
		bridgeFakes.localCommand.mockReset();
		bridgeFakes.cloudCommand.mockReset();
	});

	it("discovers and binds the current desktop through the real client wiring", async () => {
		bridgeFakes.localCommand.mockResolvedValue(connectedDevice("current-mac"));
		bridgeFakes.cloudCommand.mockReturnValue(undefined);

		await expect(
			bindCloudWorkspaceToLocalDevice("workspace-from-slack"),
		).resolves.toBe(true);

		expect(bridgeFakes.localCommand).toHaveBeenCalledWith(
			"deviceBridge.control",
			{ _tag: "status" },
		);
		expect(bridgeFakes.cloudCommand).toHaveBeenCalledWith({
			workspaceId: "workspace-from-slack",
			action: { _tag: "status" },
			targetDeviceId: "current-mac",
		});
	});

	it("leaves the target unchanged outside the desktop app", async () => {
		bridgeFakes.desktop = false;

		await expect(
			bindCloudWorkspaceToLocalDevice("workspace-from-slack"),
		).resolves.toBe(false);

		expect(bridgeFakes.localCommand).not.toHaveBeenCalled();
		expect(bridgeFakes.cloudCommand).not.toHaveBeenCalled();
	});

	it("leaves the target unchanged when local command access is disabled", async () => {
		bridgeFakes.localCommand.mockResolvedValue({
			...connectedDevice("disabled-mac"),
			enabled: false,
		});

		await expect(
			bindCloudWorkspaceToLocalDevice("workspace-from-slack"),
		).resolves.toBe(false);

		expect(bridgeFakes.localCommand).toHaveBeenCalledWith(
			"deviceBridge.control",
			{ _tag: "status" },
		);
		expect(bridgeFakes.cloudCommand).not.toHaveBeenCalled();
	});

	it("binds the cloud workspace to the desktop sending the message", async () => {
		const bindDevice = vi.fn(async () => undefined);

		await expect(
			bindCloudWorkspaceToLocalDevice("workspace-from-slack", {
				availableDevice: async () => connectedDevice("current-mac"),
				bindDevice,
			}),
		).resolves.toBe(true);

		expect(bindDevice).toHaveBeenCalledOnce();
		expect(bindDevice).toHaveBeenCalledWith(
			"workspace-from-slack",
			"current-mac",
		);
	});

	it("rebinds an existing workspace when a different desktop sends", async () => {
		const bindDevice = vi.fn(async () => undefined);
		let deviceId = "first-mac";
		const dependencies = {
			availableDevice: async () => connectedDevice(deviceId),
			bindDevice,
		};

		await bindCloudWorkspaceToLocalDevice("workspace-from-api", dependencies);
		deviceId = "second-mac";
		await bindCloudWorkspaceToLocalDevice("workspace-from-api", dependencies);

		expect(bindDevice).toHaveBeenNthCalledWith(
			1,
			"workspace-from-api",
			"first-mac",
		);
		expect(bindDevice).toHaveBeenNthCalledWith(
			2,
			"workspace-from-api",
			"second-mac",
		);
	});

	it("does not replace the target when this device cannot run commands", async () => {
		const bindDevice = vi.fn(async () => undefined);

		await expect(
			bindCloudWorkspaceToLocalDevice("workspace-from-slack", {
				availableDevice: async () => null,
				bindDevice,
			}),
		).resolves.toBe(false);

		expect(bindDevice).not.toHaveBeenCalled();
	});

	it("does not block message delivery when binding fails", async () => {
		await expect(
			bindCloudWorkspaceToLocalDevice("workspace-from-slack", {
				availableDevice: async () => connectedDevice(),
				bindDevice: async () => {
					throw new Error("control plane offline");
				},
			}),
		).resolves.toBe(false);
	});
});
