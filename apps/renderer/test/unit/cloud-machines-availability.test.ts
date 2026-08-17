import { describe, expect, it } from "vitest";
import { cloudMachinesAvailable } from "../../src/lib/cloud-machines-availability.ts";

describe("cloud machine availability", () => {
	it("is available in desktop builds", () => {
		expect(cloudMachinesAvailable({ desktop: true })).toBe(true);
	});

	it("is unavailable outside the desktop app", () => {
		expect(cloudMachinesAvailable({ desktop: false })).toBe(false);
	});
});
