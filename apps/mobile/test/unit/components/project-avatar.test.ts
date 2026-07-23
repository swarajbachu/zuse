import type { GitOriginInfo } from "@zuse/contracts";
import { describe, expect, test } from "vitest";

import {
	resolveProjectAvatarUrl,
	shouldHydrateProjectAvatar,
} from "../../../src/lib/project-avatar";

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

	test("waits for a live connection and retries unresolved origins", () => {
		expect(
			shouldHydrateProjectAvatar({
				connectionStatus: "connecting",
				originResolved: false,
				loading: false,
				generation: 1,
			}),
		).toBe(false);
		expect(
			shouldHydrateProjectAvatar({
				connectionStatus: "connected",
				originResolved: false,
				loading: false,
				generation: 1,
			}),
		).toBe(true);
		expect(
			shouldHydrateProjectAvatar({
				connectionStatus: "connected",
				originResolved: true,
				loading: false,
				generation: 1,
			}),
		).toBe(false);
		expect(
			shouldHydrateProjectAvatar({
				connectionStatus: "connected",
				originResolved: false,
				loading: false,
				generation: 1,
				attemptedGeneration: 1,
			}),
		).toBe(false);
		expect(
			shouldHydrateProjectAvatar({
				connectionStatus: "connected",
				originResolved: false,
				loading: false,
				generation: 2,
				attemptedGeneration: 1,
			}),
		).toBe(true);
	});
});
