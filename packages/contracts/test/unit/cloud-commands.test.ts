import { describe, expect, it } from "vitest";
import {
	isCloudCommandFailureState,
	isCloudCommandTerminalState,
} from "../../src/cloud-commands.ts";

describe("cloud command state", () => {
	it("owns terminal-state classification for every mailbox consumer", () => {
		expect(isCloudCommandTerminalState("applied")).toBe(true);
		expect(isCloudCommandTerminalState("waiting-for-runtime")).toBe(false);
		expect(isCloudCommandFailureState("outcome-unknown")).toBe(true);
		expect(isCloudCommandFailureState("applied")).toBe(false);
	});
});
