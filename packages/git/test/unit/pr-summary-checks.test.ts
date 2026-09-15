import { expect, test } from "vitest";
import { checkRunFromRollup } from "../../src/check-runs.js";

test("summary checks expose usable names and CI links without workflow enrichment", () => {
	const run = checkRunFromRollup({
		name: "test (packages)",
		status: "COMPLETED",
		conclusion: "FAILURE",
		detailsUrl: "https://github.com/acme/app/actions/runs/1/job/2",
	});
	expect(run).toMatchObject({
		name: "test (packages)",
		status: "completed",
		conclusion: "failure",
		url: "https://github.com/acme/app/actions/runs/1/job/2",
	});
});

test("external pending statuses remain pending and preserve their context label", () => {
	expect(
		checkRunFromRollup({
			context: "Vercel",
			state: "PENDING",
			targetUrl: "https://vercel.com/deployment",
		}),
	).toMatchObject({
		name: "Vercel",
		status: "pending",
		conclusion: null,
		url: "https://vercel.com/deployment",
	});
	expect(
		checkRunFromRollup({ context: "Vercel", state: "ERROR" }),
	).toMatchObject({ status: "completed", conclusion: "failure" });
});
