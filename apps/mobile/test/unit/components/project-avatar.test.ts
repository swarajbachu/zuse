import type { GitOriginInfo } from "@zuse/contracts";
import { describe, expect, test } from "vitest";

import { resolveProjectAvatarUrl } from "../../../src/lib/project-avatar";

describe("project avatar resolution", () => {
	const canonicalOrigin = {
		host: "github.com",
		owner: "canonical-owner",
		repo: "project",
	} as GitOriginInfo;

	test("uses the provisional source until origin hydration resolves", () => {
		expect(
			resolveProjectAvatarUrl(undefined, "https://example.com/guess.png"),
		).toBe("https://example.com/guess.png");
	});

	test("uses the canonical owner after origin hydration", () => {
		expect(
			resolveProjectAvatarUrl(canonicalOrigin, "https://example.com/guess.png"),
		).toBe("https://github.com/canonical-owner.png?size=80");
	});

	test("preserves initials fallback when neither source exists", () => {
		expect(resolveProjectAvatarUrl(null, null)).toBeNull();
	});
});
