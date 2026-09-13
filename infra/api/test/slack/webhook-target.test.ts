import { isSlackWebhookTarget } from "@zuse/slack/webhook-target";
import { describe, expect, it } from "vitest";
import { safeApiWebhookTarget } from "../../src/api-webhook-target.ts";

describe("internal Slack webhook boundary", () => {
	const origin = "https://api.zuse.sh";
	const path = `/slack/webhook/T1/${"a".repeat(64)}`;
	it("recognizes only the exact configured receiver without weakening public SSRF checks", () => {
		expect(isSlackWebhookTarget(origin + path, origin)).toBe(true);
		expect(safeApiWebhookTarget(origin + path, origin)).toBeNull();
	});
	it.each([
		"https://attacker.test",
		"https://api.zuse.sh.attacker.test",
		"https://api-staging.zuse.sh",
		"http://api.zuse.sh",
	])("rejects an unconfigured origin %s", (target) => {
		expect(isSlackWebhookTarget(target + path, origin)).toBe(false);
	});
	it.each([
		"/v1/account",
		"/slack/events",
		"/slack/webhook/T1/invalid",
		`${path}?redirect=https://attacker.test`,
		`${path}#fragment`,
		`${path}/extra`,
	])("rejects non-receiver paths and URL suffixes %s", (target) => {
		expect(isSlackWebhookTarget(origin + target, origin)).toBe(false);
	});
	it("rejects embedded credentials and malformed URLs", () => {
		expect(
			isSlackWebhookTarget(`https://user:pass@api.zuse.sh${path}`, origin),
		).toBe(false);
		expect(isSlackWebhookTarget("invalid", origin)).toBe(false);
	});
});
