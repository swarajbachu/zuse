import { describe, expect, it } from "vitest";
import { cloudMachinesAvailable } from "../../src/lib/cloud-machines-availability.ts";

describe("cloud machine availability", () => {
	it("is hidden in production desktop builds", () => {
		expect(cloudMachinesAvailable({ desktop: true, development: false })).toBe(
			false,
		);
	});

	it("remains available in desktop development builds", () => {
		expect(cloudMachinesAvailable({ desktop: true, development: true })).toBe(
			true,
		);
	});

	it("is unavailable outside the desktop app", () => {
		expect(cloudMachinesAvailable({ desktop: false, development: true })).toBe(
			false,
		);
	});
});
