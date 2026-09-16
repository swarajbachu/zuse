import { CommandId, EnvironmentId } from "@zuse/contracts";
import { Effect } from "effect";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
	isLocalDeviceConnectionReady,
	localDeviceCommand,
} from "../../src/lib/local-device-client-bus.ts";
import {
	getRendererClientBus,
	resetSessionTimelineClientBusForTest,
	setSessionTimelineRpcClientForTest,
} from "../../src/lib/session-timeline-client-bus.ts";

describe("local device ClientBus commands", () => {
	afterEach(() => resetSessionTimelineClientBusForTest());
	test.each([
		{ _tag: "status" },
		{ _tag: "decide", id: "pending-command", decision: "AllowOnce" },
	])("routes device bridge $_tag requests to the local runtime", async (action) => {
		const result = {
			version: 1,
			commands: [{ id: "pending-command", state: "pending" }],
		};
		const control = vi.fn(() => Effect.succeed(result));
		const resolve = vi.fn(
			async () => ({ "deviceBridge.control": control }) as never,
		);
		setSessionTimelineRpcClientForTest(resolve);
		const receipt = await getRendererClientBus().dispatch(
			localDeviceCommand(
				EnvironmentId.make("desktop-environment"),
				"deviceBridge.control",
				action,
				CommandId.make(`bridge-${action._tag}`),
			),
		);
		expect(receipt.result).toEqual(result);
		expect(resolve).toHaveBeenCalledWith("desktop-environment");
		expect(control).toHaveBeenCalledWith(action);
	});
	test("share the local connection without publishing shell resource state", () => {
		const command = localDeviceCommand(
			EnvironmentId.make("desktop-environment"),
			"pairing.listNearbyRequests",
			{},
			CommandId.make("pairing-refresh"),
		);

		expect(command.environmentId).toBe("desktop-environment");
		expect(command.resource).toBeNull();
		expect(command.retry).toBe("never");
	});

	test("treats an offline canonical connection as unavailable to background polling", () => {
		const connection = vi.spyOn(getRendererClientBus(), "connection");
		connection.mockReturnValueOnce({ phase: "offline" } as never);
		expect(isLocalDeviceConnectionReady()).toBe(false);

		connection.mockReturnValueOnce({ phase: "connected" } as never);
		expect(isLocalDeviceConnectionReady()).toBe(true);
		connection.mockRestore();
	});
});
