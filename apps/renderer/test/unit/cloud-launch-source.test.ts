import { describe, expect, it } from "vitest";

import { cloudLaunchRequestForSource } from "../../src/lib/cloud-launch-source.ts";

describe("cloud launch source", () => {
	it("starts from the project's default branch without a create-from source", () => {
		expect(cloudLaunchRequestForSource(null, "main")).toEqual({
			ok: true,
			ref: { baseRef: "origin/main" },
		});
	});

	it("keeps issue and Linear sources on the default branch", () => {
		expect(cloudLaunchRequestForSource({ kind: "issue" }, "trunk")).toEqual({
			ok: true,
			ref: { baseRef: "origin/trunk" },
		});
		expect(cloudLaunchRequestForSource({ kind: "linear" }, "trunk")).toEqual({
			ok: true,
			ref: { baseRef: "origin/trunk" },
		});
	});

	it("checks out a pull request's head branch in the sandbox", () => {
		expect(
			cloudLaunchRequestForSource(
				{
					kind: "pr",
					number: 12,
					headRefName: "feature/cloud-uploads",
					isCrossRepository: false,
				},
				"main",
			),
		).toEqual({
			ok: true,
			ref: {
				branch: "feature/cloud-uploads",
				baseRef: "origin/feature/cloud-uploads",
			},
		});
	});

	it("refuses a fork pull request the sandbox image cannot fetch", () => {
		const result = cloudLaunchRequestForSource(
			{
				kind: "pr",
				number: 12,
				headRefName: "patch-1",
				isCrossRepository: true,
			},
			"main",
		);

		expect(result.ok).toBe(false);
		expect(result.ok === false && result.message).toContain("fork");
	});

	it("refuses a branch that only exists locally", () => {
		const result = cloudLaunchRequestForSource(
			{ kind: "branch", branch: "wip", remote: null },
			"main",
		);

		expect(result.ok).toBe(false);
		expect(result.ok === false && result.message).toContain("Push");
	});

	it("mirrors the control plane's branch-name validation", () => {
		expect(
			cloudLaunchRequestForSource(
				{ kind: "branch", branch: "feature/ok-1.2", remote: "origin" },
				"main",
			),
		).toEqual({
			ok: true,
			ref: { branch: "feature/ok-1.2", baseRef: "origin/feature/ok-1.2" },
		});
		expect(
			cloudLaunchRequestForSource(
				{ kind: "branch", branch: "feature/oops branch", remote: "origin" },
				"main",
			).ok,
		).toBe(false);
	});
});
