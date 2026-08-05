import { MachineOpError } from "@zuse/contracts";
import { describe, expect, it } from "vitest";

import {
	checkoutErrorMessage,
	visibleCloudMachineError,
} from "../../src/lib/cloud-machine-errors.ts";

describe("cloud machine errors", () => {
	it("keeps an action failure visible after a successful background refresh", () => {
		expect(
			visibleCloudMachineError(
				null,
				"Checkout could not be created. Please try again.",
			),
		).toBe("Checkout could not be created. Please try again.");
	});

	it("gives checkout provider failures a recoverable message", () => {
		expect(
			checkoutErrorMessage(
				new MachineOpError({ code: "provider-unavailable" }),
			),
		).toBe("Checkout could not be created. Please try again.");
	});
});
