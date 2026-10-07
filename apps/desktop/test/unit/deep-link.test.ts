import { describe, expect, it } from "vitest";

import {
	createBufferedChannel,
	isPairingDeepLink,
	isReviewDeepLink,
	pluginReturnOf,
} from "../../src/deep-link.ts";

describe("review deep-link routing", () => {
	it("separates review navigation from pairing and rejects credentials", () => {
		const link = "zuse:///review/fix?runId=run-1&findingId=finding-1";
		expect(isReviewDeepLink(link)).toBe(true);
		expect(isPairingDeepLink(link)).toBe(false);
		expect(isReviewDeepLink(`${link}&token=secret`)).toBe(false);
		expect(isReviewDeepLink("zuse:///connect/pair")).toBe(false);
	});
});

describe("isPairingDeepLink", () => {
	it.each([
		"zuse:///connect/pair?pairingUrl=wss%3A%2F%2Fbuild.example.ts.net%2Frpc#token=zp_once",
		"zuse:///connect/pair",
		"zuse://connect/pair?pairingUrl=wss%3A%2F%2Fbuild.example.ts.net%2Frpc#token=zp_once",
		"memoize:///connect/pair?pairingUrl=wss%3A%2F%2Fbuild.example.ts.net%2Frpc#token=zp_once",
		"memoize://connect/pair",
	])("accepts %s", (link) => {
		expect(isPairingDeepLink(link)).toBe(true);
	});

	it.each([
		"zuse://auth/callback?code=abc",
		"zuse:///auth",
		"zuse:///connect/other",
		"https://connect/pair",
		"not a url",
		"",
	])("rejects %s", (link) => {
		expect(isPairingDeepLink(link)).toBe(false);
	});
});

describe("createBufferedChannel", () => {
	it("buffers until a subscriber attaches, then flushes in order", () => {
		const channel = createBufferedChannel<string>();
		channel.publish("first");
		channel.publish("second");
		const received: string[] = [];
		channel.subscribe((item) => received.push(item));
		expect(received).toEqual(["first", "second"]);
	});

	it("delivers post-subscribe items immediately", () => {
		const channel = createBufferedChannel<string>();
		const received: string[] = [];
		channel.subscribe((item) => received.push(item));
		channel.publish("live");
		expect(received).toEqual(["live"]);
	});

	it("replaces the subscriber on re-subscribe without re-delivering", () => {
		const channel = createBufferedChannel<string>();
		const first: string[] = [];
		const second: string[] = [];
		channel.subscribe((item) => first.push(item));
		channel.publish("one");
		channel.subscribe((item) => second.push(item));
		channel.publish("two");
		expect(first).toEqual(["one"]);
		expect(second).toEqual(["two"]);
	});
});

describe("pluginReturnOf", () => {
	const parse = (query: string) =>
		pluginReturnOf(new URL(`http://localhost:8976/plugins/callback?${query}`));

	it("reads a ticket return", () => {
		expect(
			parse("plugin_ticket=t1&plugin_tenant=personal%3Aa&plugin=Linear"),
		).toEqual({
			ticket: "t1",
			tenantId: "personal:a",
			plugin: "Linear",
			error: null,
		});
	});

	it("reads a cancelled return", () => {
		expect(parse("plugin_error=cancelled&plugin_tenant=personal%3Aa")).toEqual({
			ticket: null,
			tenantId: "personal:a",
			plugin: null,
			error: "cancelled",
		});
	});

	it.each([
		"plugin_ticket=t1",
		"plugin_tenant=personal%3Aa",
		"plugin_ticket=t1&plugin_error=x&plugin_tenant=personal%3Aa",
		`plugin_ticket=${"x".repeat(513)}&plugin_tenant=personal%3Aa`,
	])("rejects %s", (query) => {
		expect(parse(query)).toBeNull();
	});
});
