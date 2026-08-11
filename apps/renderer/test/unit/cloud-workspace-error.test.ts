import { CloudWorkspaceOpError } from "@zuse/contracts";
import { describe, expect, test } from "vitest";
import { formatError } from "../../src/lib/format-error.ts";

describe("cloud workspace errors", () => {
	test("explains when a project snapshot must be prepared again", () => {
		expect(
			formatError(new CloudWorkspaceOpError({ code: "project-not-ready" })),
		).toBe(
			"This cloud project needs to be prepared again before starting a workspace.",
		);
	});
});
