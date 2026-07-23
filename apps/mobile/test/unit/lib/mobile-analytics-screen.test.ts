import { describe, expect, test } from "vitest";

import { mobileAnalyticsScreen } from "../../../src/lib/mobile-analytics-screen";

describe("mobile analytics screen names", () => {
	test.each([
		["/", "chats"],
		["/settings", "settings"],
		["/new-chat", "new chat"],
		["/connect/nearby", "nearby connection"],
		["/connect/manual", "manual connection"],
		["/connect/scan", "connection scanner"],
		["/connect/pair", "connection pairing"],
		["/plan-viewer", "plan viewer"],
		["/unknown", "other"],
	] as const)("maps %s to %s", (pathname, screen) => {
		expect(mobileAnalyticsScreen(pathname)).toBe(screen);
	});

	test.each([
		["/c/local/review", "review"],
		["/c/local/files", "files"],
		["/c/local/file/readme", "files"],
		["/c/local/tool/123", "tool details"],
		["/c/local/session/123", "session"],
		["/c/local/chat/123/threads", "chat threads"],
		["/c/local", "sessions"],
	] as const)("maps connection route %s to %s", (pathname, screen) => {
		expect(mobileAnalyticsScreen(pathname)).toBe(screen);
	});
});
