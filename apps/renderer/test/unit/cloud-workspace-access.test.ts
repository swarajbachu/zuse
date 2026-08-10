import { describe, expect, test } from "vitest";
import { cloudWorkspaceAccessPresentation } from "../../src/lib/cloud-workspace-access.ts";

describe("cloud workspace access presentation", () => {
	test("preserves paid access when the desktop is newer than the relay", () => {
		expect(
			cloudWorkspaceAccessPresentation({
				entitlementSubscribed: false,
				legacySandboxSubscribed: true,
				serviceAvailable: false,
			}),
		).toEqual({
			subscribed: true,
			serviceError:
				"Your subscription is active. Cloud workspace controls require the relay update.",
		});
	});

	test("does not claim a subscription when neither billing signal exists", () => {
		expect(
			cloudWorkspaceAccessPresentation({
				entitlementSubscribed: false,
				legacySandboxSubscribed: false,
				serviceAvailable: false,
			}),
		).toEqual({
			subscribed: false,
			serviceError: "Cloud workspace services are temporarily unavailable.",
		});
	});
});
