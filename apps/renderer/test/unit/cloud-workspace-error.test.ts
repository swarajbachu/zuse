import {
	CloudWorkspaceOpError,
	WorkspaceDuplicatePathError,
} from "@zuse/contracts";
import { describe, expect, test } from "vitest";
import { formatError } from "../../src/lib/format-error.ts";

describe("cloud workspace errors", () => {
	test("explains when workspace credentials must be connected", () => {
		expect(
			formatError(new CloudWorkspaceOpError({ code: "credential-required" })),
		).toBe(
			"Connect GitHub and the selected agent in Cloud Sandbox settings, then try again.",
		);
	});

	test("explains when a project snapshot must be prepared again", () => {
		expect(
			formatError(new CloudWorkspaceOpError({ code: "project-not-ready" })),
		).toBe(
			"This cloud project needs to be prepared again before starting a workspace.",
		);
	});

	test("distinguishes invite denial from an unavailable access check", () => {
		expect(
			formatError(new CloudWorkspaceOpError({ code: "beta-access-required" })),
		).toBe("Zuse Cloud is currently invite-only.");
		expect(
			formatError(
				new CloudWorkspaceOpError({ code: "beta-access-unavailable" }),
			),
		).toBe("Cloud access could not be verified. Try again shortly.");
	});
});

describe("workspace import errors", () => {
	test("explains when a folder is already in the workspace", () => {
		expect(
			formatError(
				new WorkspaceDuplicatePathError({ path: "/projects/already" }),
			),
		).toBe("That folder is already in your workspace.");
	});
});
