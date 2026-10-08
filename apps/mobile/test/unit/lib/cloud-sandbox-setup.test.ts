import { describe, expect, test } from "vitest";

import { cloudSandboxStatus } from "../../../src/lib/cloud-sandbox-setup";

const image = (
	providerId: string,
	state: string,
	projectIds: readonly string[],
) =>
	({
		providerId,
		state,
		repositories: projectIds.map((projectId) => ({ projectId })),
	}) as never;

const catalog = {
	subscribed: true,
	providerImages: [
		image("boxd", "ready", ["repo-a"]),
		image("e2b", "building", ["repo-a"]),
		image("box", "auth-broken", []),
	],
};

describe("cloud sandbox readiness", () => {
	test("is ready only when the image includes the chosen repository", () => {
		expect(cloudSandboxStatus(catalog, "boxd", "repo-a")).toEqual({
			setup: "ready",
			label: null,
		});
		expect(cloudSandboxStatus(catalog, "boxd", "repo-b").setup).toBe(
			"update-image",
		);
	});

	test("explains why a provider is not ready", () => {
		expect(cloudSandboxStatus(catalog, "e2b", "repo-a").label).toBe(
			"Building cloud image",
		);
		expect(cloudSandboxStatus(catalog, "box", "repo-a").label).toBe(
			"Rebuild authentication",
		);
		expect(cloudSandboxStatus(catalog, "unknown", "repo-a").label).toBe(
			"Unavailable",
		);
		expect(
			cloudSandboxStatus({ ...catalog, subscribed: false }, "boxd", "repo-a")
				.label,
		).toBe("Subscription required");
		expect(cloudSandboxStatus(catalog, "boxd", null).label).toBe(
			"Connect a repository",
		);
	});

	test("without a chosen repository, checks any connected repository", () => {
		expect(cloudSandboxStatus(catalog, "boxd").setup).toBe("ready");
		expect(cloudSandboxStatus(catalog, "box").setup).toBe("connect-repository");
	});
});
