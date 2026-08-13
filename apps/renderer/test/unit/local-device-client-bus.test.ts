import { CommandId, EnvironmentId } from "@zuse/contracts";
import { describe, expect, test } from "vitest";
import { localDeviceCommand } from "../../src/lib/local-device-client-bus.ts";

describe("local device ClientBus commands", () => {
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
});
