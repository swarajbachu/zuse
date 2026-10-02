import { describe, expect, test } from "vitest";
import { redirectSystemPath } from "../../app/+native-intent";
import { mobileCloudChatLinkRoute } from "../../src/lib/cloud-chat-link";

describe("mobile shared-chat URL routing", () => {
	test.each([
		"/w/organization/org_a/chat/chat%20a",
		"https://app.zuse.dev/w/organization/org_a/chat/chat%20a",
		"zuse://w/organization/org_a/chat/chat%20a",
		"zuse-dev:///w/organization/org_a/chat/chat%20a",
	])("normalizes only the chat locator: %s", (path) => {
		expect(mobileCloudChatLinkRoute(path)).toBe(
			"/shared-chat?path=%2Fw%2Forganization%2Forg_a%2Fchat%2Fchat%2520a",
		);
	});
	test.each([
		"javascript:alert(1)",
		"https://example.com/login",
		"/w/personal/chat/%xx",
		"/w/personal/chat",
		"file:///w/personal/chat/a",
	])("rejects unsupported links: %s", (path) => {
		expect(mobileCloudChatLinkRoute(path)).toBeNull();
	});
	test("preserves existing notification and pairing routes", () => {
		expect(
			redirectSystemPath({ path: "zuse://computers", initial: true }),
		).toBe("/");
		expect(redirectSystemPath({ path: "/connect/scan", initial: true })).toBe(
			"/connect/scan",
		);
		expect(
			redirectSystemPath({ path: "/w/personal/chat/a", initial: true }),
		).toBe("/shared-chat?path=%2Fw%2Fpersonal%2Fchat%2Fa");
	});
});
