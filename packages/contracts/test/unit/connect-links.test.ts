import { describe, expect, it } from "vitest";

import {
	buildBrowserPairUrl,
	buildConnectDeepLink,
	formatPairingCodeForDisplay,
	isPrivateOrLocalHost,
	normalizePairingCodeInput,
	parseConnectLink,
	wsBaseUrlForHttpBase,
} from "../../src/connect-links.ts";

const link = (pairingUrl: string, code = "zp_code") =>
	`zuse:///connect/pair?pairingUrl=${encodeURIComponent(pairingUrl)}#token=${code}`;

describe("parseConnectLink", () => {
	it.each([
		["wss://build.example.ts.net/rpc", "tailscale"],
		["wss://zenv-abc123.stuff.md/rpc", "relay"],
		["wss://tunnel.trycloudflare.com/rpc", "relay"],
		["wss://example.com/rpc", "remote"],
		["ws://192.168.1.50:4859", "lan"],
		["ws://devbox.local:4859", "lan"],
		["ws://10.0.0.7:4859", "lan"],
	] as const)("classifies %s as %s", (pairingUrl, kind) => {
		const result = parseConnectLink(link(pairingUrl));
		expect(result).toMatchObject({ ok: true, link: { kind } });
	});

	it("rejects plaintext endpoints on public hosts", () => {
		expect(parseConnectLink(link("ws://example.com/rpc"))).toEqual({
			ok: false,
			reason: "insecure-endpoint",
		});
	});

	it("rejects endpoints with userinfo", () => {
		expect(parseConnectLink(link("wss://user:pw@example.com/rpc"))).toEqual({
			ok: false,
			reason: "unreachable-endpoint",
		});
	});

	it("rejects non-zuse schemes", () => {
		expect(
			parseConnectLink("https://example.com/?pairingUrl=wss%3A%2F%2Fa#token=x"),
		).toEqual({ ok: false, reason: "wrong-scheme" });
	});

	it("rejects links missing the code or endpoint", () => {
		expect(
			parseConnectLink("zuse:///connect/pair?pairingUrl=wss%3A%2F%2Fa"),
		).toEqual({ ok: false, reason: "incomplete" });
	});

	it("derives base URLs for a bare LAN endpoint", () => {
		const result = parseConnectLink(link("ws://192.168.1.50:4859"));
		expect(result).toMatchObject({
			ok: true,
			link: {
				httpBaseUrl: "http://192.168.1.50:4859",
				wsBaseUrl: "ws://192.168.1.50:4859/rpc",
			},
		});
	});

	it("keeps an explicit endpoint path", () => {
		const result = parseConnectLink(link("wss://build.example.ts.net/rpc"));
		expect(result).toMatchObject({
			ok: true,
			link: {
				httpBaseUrl: "https://build.example.ts.net",
				wsBaseUrl: "wss://build.example.ts.net/rpc",
			},
		});
	});
});

describe("builders", () => {
	it("round-trips a deep link through the parser", () => {
		const deepLink = buildConnectDeepLink({
			wsBaseUrl: "wss://build.example.ts.net/rpc",
			code: "zp_abc",
		});
		const result = parseConnectLink(deepLink);
		expect(result).toMatchObject({
			ok: true,
			link: { code: "zp_abc", wsBaseUrl: "wss://build.example.ts.net/rpc" },
		});
	});

	it("builds browser pair URLs without doubled slashes", () => {
		expect(
			buildBrowserPairUrl({
				httpBaseUrl: "https://zenv-abc.stuff.md/",
				code: "zp_abc",
			}),
		).toBe("https://zenv-abc.stuff.md/#pair=zp_abc");
	});

	it("derives ws base URLs from http bases", () => {
		expect(wsBaseUrlForHttpBase("https://zenv-abc.stuff.md/")).toBe(
			"wss://zenv-abc.stuff.md/rpc",
		);
		expect(wsBaseUrlForHttpBase("http://192.168.1.50:4859")).toBe(
			"ws://192.168.1.50:4859/rpc",
		);
	});
});

describe("isPrivateOrLocalHost", () => {
	it.each([
		["127.0.0.1", true],
		["localhost", true],
		["::1", true],
		["[::1]", true],
		["10.1.2.3", true],
		["192.168.1.50", true],
		["172.16.0.1", true],
		["172.31.255.255", true],
		["169.254.10.10", true],
		["devbox.local", true],
		["fe80::1", true],
		["172.32.0.1", false],
		["192.169.1.1", false],
		["example.com", false],
		["8.8.8.8", false],
	] as const)("%s → %s", (host, expected) => {
		expect(isPrivateOrLocalHost(host)).toBe(expected);
	});
});

describe("pairing codes", () => {
	it("formats short codes with a display dash", () => {
		expect(formatPairingCodeForDisplay("ABCDEFGH")).toBe("ABCD-EFGH");
		expect(formatPairingCodeForDisplay("zp_abc123")).toBe("zp_abc123");
	});

	it("normalizes typed short codes", () => {
		expect(normalizePairingCodeInput(" abcd-efgh ")).toBe("ABCDEFGH");
		expect(normalizePairingCodeInput("abcd efgh")).toBe("ABCDEFGH");
		expect(normalizePairingCodeInput("ABCDEFGH")).toBe("ABCDEFGH");
	});

	it("passes legacy codes through untouched", () => {
		expect(normalizePairingCodeInput(" zp_AbC123xyz ")).toBe("zp_AbC123xyz");
	});
});
