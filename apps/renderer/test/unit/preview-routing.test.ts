import { PreviewOpError } from "@zuse/contracts";
import { describe, expect, it } from "vitest";

import {
	localPreviewUrl,
	previewErrorDetails,
} from "../../src/lib/preview-routing.ts";

describe("preview routing", () => {
	it("maps private-network setup failures to a specific recovery action", () => {
		expect(
			previewErrorDetails(
				new PreviewOpError({ code: "private-network-required" }),
			),
		).toEqual({
			message: "Turn on Private networking in Cloud Space, then retry.",
			approvalUrl: null,
		});
	});

	it("preserves only the safe feature-approval URL", () => {
		const approvalUrl = "https://login.tailscale.com/f/serve?node=example";
		expect(
			previewErrorDetails(
				new PreviewOpError({
					code: "private-preview-approval-required",
					approvalUrl,
				}),
			),
		).toEqual({
			message: "Approve private HTTPS for this network, then retry.",
			approvalUrl,
		});
		expect(
			previewErrorDetails(
				new PreviewOpError({
					code: "private-preview-approval-required",
					approvalUrl: "https://example.test/steal-session",
				}),
			).approvalUrl,
		).toBeNull();
	});

	it("keeps local previews on loopback", () => {
		expect(localPreviewUrl(3001)).toBe("http://localhost:3001");
	});
});
