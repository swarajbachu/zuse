import type { MachineRecord } from "@zuse/contracts";
import { describe, expect, test } from "vitest";
import { selectActiveCloudMachine } from "../../src/lib/cloud-machine-selection.ts";

const machine = (
	state: MachineRecord["state"],
	kind: MachineRecord["offer"]["kind"] = "persistent",
): MachineRecord => ({ state, offer: { kind } }) as MachineRecord;

describe("selectActiveCloudMachine", () => {
	test("returns no active machine when only destroyed history remains", () => {
		expect(
			selectActiveCloudMachine([machine("destroyed")], "persistent"),
		).toBeNull();
	});

	test("selects the current non-destroyed machine", () => {
		const ready = machine("ready");
		expect(
			selectActiveCloudMachine([machine("destroyed"), ready], "persistent"),
		).toBe(ready);
	});

	test("selects independently by offer kind", () => {
		const persistent = machine("ready", "persistent");
		const sandbox = machine("ready", "sandbox");

		expect(selectActiveCloudMachine([persistent, sandbox], "sandbox")).toBe(
			sandbox,
		);
	});
});
