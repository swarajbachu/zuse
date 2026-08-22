import { describe, expect, it } from "vitest";

import { describePairingLinkKind } from "../../src/lib/pairing-link.ts";

const link = (pairingUrl: string, withToken = true): string =>
	`zuse:///connect/pair?pairingUrl=${encodeURIComponent(pairingUrl)}${
		withToken ? "#token=zp_once" : ""
	}`;

describe("describePairingLinkKind", () => {
	it.each([
		["https://build.example.ts.net/#pair=zp_once", "tailscale"],
		["http://192.168.1.50:4859/#pair=zp_once", "lan"],
		[link("wss://build.example.ts.net/rpc"), "tailscale"],
		[link("wss://calm-otter.trycloudflare.com/rpc"), "relay"],
		[link("wss://example.com/rpc"), "remote"],
		[link("wss://192.0.2.10:8443/rpc"), "remote"],
		[
			`memoize://connect/pair?pairingUrl=${encodeURIComponent(
				"wss://build.example.ts.net/rpc",
			)}#token=zp_once`,
			"tailscale",
		],
		[link("ws://build.example.ts.net/rpc"), "invalid"],
		[link("ws://192.168.1.50:4859"), "lan"],
		[link("ws://devbox.local:4859"), "lan"],
		[link("ws://203.0.113.7:4859"), "invalid"],
		[link("wss://user:pass@example.com/rpc"), "invalid"],
		[link("wss://example.com/rpc", false), "invalid"],
		["zuse:///connect/pair#token=zp_once", "invalid"],
		[
			`https://example.com/pair?pairingUrl=wss%3A%2F%2Fa.ts.net#token=x`,
			"invalid",
		],
		["not a url", "invalid"],
		["", "invalid"],
	])("classifies %s as %s", (value, expected) => {
		expect(describePairingLinkKind(value)).toBe(expected);
	});
});
