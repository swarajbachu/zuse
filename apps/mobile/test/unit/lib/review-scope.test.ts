import { describe, expect, it } from "vitest";

import {
	reviewScopeCompatibilityError,
	reviewScopeRequestValue,
} from "../../../src/lib/review-scope";

describe("reviewScopeCompatibilityError", () => {
	it("rejects a stale branch response for a staged request", () => {
		expect(reviewScopeCompatibilityError("staged", "branch")).toContain(
			"Restart",
		);
	});

	it("accepts a response for the requested comparison", () => {
		expect(reviewScopeCompatibilityError("unstaged", "unstaged")).toBeNull();
		expect(reviewScopeCompatibilityError("branch", "branch")).toBeNull();
	});

	it("centralizes the legacy branch payload compatibility rule", () => {
		expect(reviewScopeRequestValue(undefined)).toBeUndefined();
		expect(reviewScopeRequestValue("branch")).toBeUndefined();
		expect(reviewScopeRequestValue("staged")).toBe("staged");
		expect(reviewScopeRequestValue("unstaged")).toBe("unstaged");
	});
});
