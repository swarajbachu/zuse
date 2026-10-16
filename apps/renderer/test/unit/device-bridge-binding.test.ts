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

	it("binds after slow desktop discovery without delaying the message", async () => {
		vi.useFakeTimers();
		try {
			bridgeFakes.localCommand.mockImplementation(
				() =>
					new Promise((resolve) =>
						setTimeout(() => resolve(connectedDevice()), 1_000),
					),
			);
			const binding = bindCloudWorkspaceToLocalDevice("workspace-1");
			await vi.advanceTimersByTimeAsync(500);
			await expect(binding).resolves.toBe(false);
			expect(bridgeFakes.cloudCommand).not.toHaveBeenCalled();
			await vi.advanceTimersByTimeAsync(500);
			expect(bridgeFakes.cloudCommand).toHaveBeenCalledWith({
				workspaceId: "workspace-1",
				action: { _tag: "status" },
				targetDeviceId: "mac-one",
			});
		} finally {
			vi.useRealTimers();
		}
	});

	it("waits for automatic registration and shares discovery across cloud chats", async () => {
		vi.useFakeTimers();
		try {
			bridgeFakes.localCommand
				.mockResolvedValueOnce({
					...connectedDevice(),
					connected: false,
					enabled: false,
				})
				.mockResolvedValue(connectedDevice());
			const first = bindCloudWorkspaceToLocalDevice("workspace-1");
			const second = bindCloudWorkspaceToLocalDevice("workspace-2");
			await vi.advanceTimersByTimeAsync(500);
			await Promise.all([first, second]);
			expect(bridgeFakes.localCommand).toHaveBeenCalledTimes(2);
			expect(
				bridgeFakes.cloudCommand.mock.calls.map(([input]) => input.workspaceId),
			).toEqual(["workspace-1", "workspace-2"]);
		} finally {
			vi.useRealTimers();
		}
	});

	it("stops discovery when the desktop remains unavailable", async () => {
		vi.useFakeTimers();
		try {
			bridgeFakes.localCommand.mockImplementation(() => new Promise(() => {}));
			const binding = bindCloudWorkspaceToLocalDevice("workspace-1");
			await vi.advanceTimersByTimeAsync(30_000);
			await expect(binding).resolves.toBe(false);
			expect(bridgeFakes.cloudCommand).not.toHaveBeenCalled();
			expect(vi.getTimerCount()).toBe(0);
		} finally {
			vi.useRealTimers();
		}
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

it("releases message dispatch within 500 ms when optional cloud binding stalls", async () => {
	vi.useFakeTimers();
	try {
		const pending = bindCloudWorkspaceToLocalDevice("workspace-1", {
			availableDevice: async () => connectedDevice(),
			bindDevice: () => new Promise(() => {}),
		});
		await vi.advanceTimersByTimeAsync(500);
		await expect(pending).resolves.toBe(false);
	} finally {
		vi.useRealTimers();
	}
});
