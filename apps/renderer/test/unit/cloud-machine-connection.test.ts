import { describe, expect, it } from "vitest";

import { cloudConnectionPresentation } from "../../src/lib/cloud-machine-connection.ts";

describe("cloud machine connection presentation", () => {
	it("keeps machine readiness separate from desktop connection state", () => {
		expect(cloudConnectionPresentation(undefined)).toMatchObject({
			label: "Not connected",
			variant: "warning",
		});
		expect(cloudConnectionPresentation("connecting")).toMatchObject({
			label: "Connecting",
			variant: "info",
		});
		expect(cloudConnectionPresentation("connected")).toMatchObject({
			label: "Connected",
			variant: "success",
		});
	});

	it("surfaces catalog connection failures for a retry", () => {
		expect(
			cloudConnectionPresentation("error", "Connect grant expired."),
		).toEqual({
			description: "Connect grant expired.",
			label: "Connection failed",
			variant: "error",
		});
	});
});
