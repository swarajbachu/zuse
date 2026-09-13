import type { ComputerAwakeStatus } from "@zuse/contracts";
import { describe, expect, it } from "vitest";

import {
	computerAwakeModeDescription,
	computerAwakeStatusText,
	localRuntimeEnvironmentId,
} from "../../src/lib/computer-awake.ts";

const status = (
	overrides: Partial<ComputerAwakeStatus> = {},
): ComputerAwakeStatus => ({
	supported: true,
	mode: "auto",
	active: false,
	activeAgents: 0,
	remoteClients: 0,
	electronBlockerActive: false,
	caffeinateActive: false,
	warning: null,
	...overrides,
});

describe("computer awake renderer behavior", () => {
	it("explains each mode in terms of when the Mac stays awake", () => {
		expect(computerAwakeModeDescription("off")).toContain("sleep normally");
		expect(computerAwakeModeDescription("auto")).toBe(
			"Keeps this Mac awake while a local agent is working or an authenticated remote client is connected.",
		);
		expect(computerAwakeModeDescription("always")).toContain(
			"whenever Zuse is open",
		);
	});

	it("reports the local environment even when a remote environment is active", () => {
		expect(
			localRuntimeEnvironmentId(
				[
					{ connectionKind: "api", environmentId: "remote" },
					{ connectionKind: "local", environmentId: "this-mac" },
				],
				"remote",
			),
		).toBe("this-mac");
	});

	it("presents active triggers and degraded assertion state", () => {
		expect(
			computerAwakeStatusText(
				status({ active: true, activeAgents: 2, remoteClients: 1 }),
			),
		).toBe("2 local agents running · Active — 1 remote client connected.");
		expect(
			computerAwakeStatusText(status({ warning: "Closed-lid unavailable." })),
		).toBe("0 local agents running · Closed-lid unavailable.");
		expect(computerAwakeStatusText(status())).toBe(
			"0 local agents running · Inactive — Auto starts for agents and remote clients.",
		);
		expect(
			computerAwakeStatusText(
				status({ mode: "off", activeAgents: 3, remoteClients: 1 }),
			),
		).toBe("3 local agents running · Inactive — normal macOS sleep behavior.");
	});
});
