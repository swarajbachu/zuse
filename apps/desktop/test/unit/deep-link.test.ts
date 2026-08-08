import { describe, expect, it } from "vitest";

import {
	createBufferedChannel,
	isPairingDeepLink,
} from "../../src/deep-link.ts";

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
