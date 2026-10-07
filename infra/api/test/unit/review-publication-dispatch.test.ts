import { Effect, Redacted } from "effect";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { layer } from "../../src/config.ts";
import { drainReviewPublicationOutbox } from "../../src/review-publication-dispatch.ts";

const readiness = vi.hoisted(() =>
	vi.fn(() => ({ available: false, reasons: [] })),
);
vi.mock("../../src/review-readiness.ts", () => ({
	getReviewReadiness: readiness,
}));
const review = {
	enabled: true,
	stagingVerified: true,
	publicationEnabled: true,
	templateId: "image",
	workerModule: "/worker.mjs",
	claudeExecutable: "/claude",
	models: ["sonnet"],
};
const run = (publicationEnabled: boolean) =>
	Effect.runPromise(
		drainReviewPublicationOutbox().pipe(
			Effect.provide(
				layer({
					apiIssuer: "https://api.example.test",
					workosJwksUrl: "https://example.test/keys",
					workosIssuer: "issuer",
					mintPrivateKey: Redacted.make("unused"),
					mintPublicKey: "unused",
					review: { ...review, publicationEnabled },
				}),
			),
		),
	);
describe("publication deployment gates", () => {
	beforeEach(() => readiness.mockClear());
	it("keeps publication disabled independently of admissions", async () => {
		expect(await run(false)).toEqual({ published: 0 });
		expect(readiness).not.toHaveBeenCalled();
	});
	it("passes configured release evidence into provider readiness", async () => {
		expect(await run(true)).toEqual({ published: 0 });
		expect(readiness).toHaveBeenCalledWith("claude", review);
	});
});
