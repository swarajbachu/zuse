import { describe, expect, it } from "vitest";
import {
	resolveSlackConfiguration,
	type SlackBindings,
} from "../../src/slack/config.ts";

describe("Slack rollout configuration", () => {
	const bindings: SlackBindings = {
		SLACK_ENABLED: "true",
		SLACK_PUBLIC_ORIGIN: "https://api-staging.zuse.sh",
		SLACK_APP_ID: "A1",
		SLACK_CLIENT_ID: "client",
		SLACK_CLIENT_SECRET: "secret",
		SLACK_SIGNING_SECRET: "signing",
		SLACK_JOBS: { send: async () => {} },
	};
	it("leaves existing API deployments independent of Slack", () => {
		expect(resolveSlackConfiguration({}, false)).toBeUndefined();
		expect(
			resolveSlackConfiguration({ ...bindings, SLACK_ENABLED: "false" }, false),
		).toBeUndefined();
	});
	it("fails closed when enabled without encryption or a required binding", () => {
		expect(() => resolveSlackConfiguration(bindings, false)).toThrow(
			"SLACK_ENABLED",
		);
		for (const field of [
			"SLACK_APP_ID",
			"SLACK_PUBLIC_ORIGIN",
			"SLACK_CLIENT_ID",
			"SLACK_CLIENT_SECRET",
			"SLACK_SIGNING_SECRET",
			"SLACK_JOBS",
		] as const)
			expect(() =>
				resolveSlackConfiguration({ ...bindings, [field]: undefined }, true),
			).toThrow("SLACK_ENABLED");
		expect(() =>
			resolveSlackConfiguration(
				{ ...bindings, SLACK_CLIENT_SECRET: "REPLACE_WITH_SECRET" },
				true,
			),
		).toThrow();
	});
	it("uses the API queue and app credentials when fully configured", () => {
		expect(resolveSlackConfiguration(bindings, true)).toEqual({
			publicOrigin: "https://api-staging.zuse.sh",
			appId: "A1",
			clientId: "client",
			clientSecret: "secret",
			signingSecret: "signing",
			queue: bindings.SLACK_JOBS,
		});
	});
});
