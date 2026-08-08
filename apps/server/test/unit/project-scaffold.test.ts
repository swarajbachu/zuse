import { describe, expect, it } from "vitest";

import {
	deriveCloneTargetName,
	expandHomePath,
} from "../../src/workspace/services/project-scaffold.ts";

describe("project scaffold paths", () => {
	it("derives clone targets across supported Git URL forms", () => {
		expect(deriveCloneTargetName("git@example.com:team/project.git")).toBe(
			"project",
		);
		expect(
			deriveCloneTargetName("https://example.com/team/project.git?ref=main"),
		).toBe("project");
	});

	it("expands only a leading home shorthand", () => {
		const join = (left: string, right: string) => `${left}/${right}`;
		expect(expandHomePath("~", "/home/user", join)).toBe("/home/user");
		expect(expandHomePath("~/Developer", "/home/user", join)).toBe(
			"/home/user/Developer",
		);
		expect(expandHomePath("/tmp/~", "/home/user", join)).toBe("/tmp/~");
	});
});
