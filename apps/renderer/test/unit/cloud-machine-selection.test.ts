import type { MachineRecord } from "@zuse/contracts";
import { describe, expect, test } from "vitest";
import { selectActiveCloudMachine } from "../../src/lib/cloud-machine-selection.ts";

const machine = (state: MachineRecord["state"]): MachineRecord =>
	({ state }) as MachineRecord;

describe("selectActiveCloudMachine", () => {
	test("returns no active machine when only destroyed history remains", () => {
		expect(selectActiveCloudMachine([machine("destroyed")])).toBeNull();
	});

	test("selects the current non-destroyed machine", () => {
		const ready = machine("ready");
		expect(selectActiveCloudMachine([machine("destroyed"), ready])).toBe(ready);
	});
});
