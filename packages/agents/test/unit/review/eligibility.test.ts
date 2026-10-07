import { describe, expect, it } from "vitest";
import { getReviewProviderEligibility } from "../../../src/review/eligibility.ts";

describe("hosted review provider eligibility", () => {
	it.each([
		"codex",
		"claude",
	])("blocks %s until every launch gate is proven", (providerId) => {
		const result = getReviewProviderEligibility(providerId);
		expect(result.status).toBe("blocked");
		expect(result.reasons).toEqual([
			"hosted-subscription-authorization-unverified",
			"native-tool-confinement-unverified",
			"durable-native-auth-unverified",
		]);
	});

	it.each([
		"",
		"Codex",
		"__proto__",
		"cursor",
		"claude-code",
	])("fails closed for unsupported identifier %j", (providerId) => {
		expect(getReviewProviderEligibility(providerId)).toEqual({
			providerId,
			status: "blocked",
			reasons: ["unsupported-provider"],
		});
	});

	it("does not share mutable reasons between callers", () => {
		const first = getReviewProviderEligibility("codex");
		Reflect.set(first.reasons, "length", 0);
		expect(getReviewProviderEligibility("codex").reasons).toHaveLength(3);
	});
});
