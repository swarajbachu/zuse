import { describe, expect, it } from "vitest";
import { notificationRoute } from "../../../src/notifications/route";

describe("notification navigation", () => {
	it.each([
		"zuse:///",
		"zuse://computers?environmentId=env_1",
		"zuse:///computers",
		"zuse-dev:///",
	])("opens the inbox for %s", (target) => {
		expect(notificationRoute(target)).toBe("/");
	});
	it.each([
		undefined,
		"https://example.com",
		"javascript:alert(1)",
		"zuse://malicious",
		"zuse://computers/delete",
		"not a URL",
	])("ignores unknown targets", (target) => {
		expect(notificationRoute(target)).toBeNull();
	});
});
