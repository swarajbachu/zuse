import { describe, expect, it } from "vitest";

import {
	extractProviderLoginUrl,
	getProviderLoginCommand,
	stripLoginTerminalControls,
} from "../../src/provider/services/login-service.ts";

describe("provider login output", () => {
	it("uses Grok's short-code browser approval flow", () => {
		expect(getProviderLoginCommand("grok")).toEqual({
			command: "grok",
			args: ["login", "--device-auth"],
		});
	});

	it("extracts default and enterprise browser URLs", () => {
		expect(
			extractProviderLoginUrl(
				"Open https://auth.x.ai/authorize?client_id=zuse to continue.",
			),
		).toBe("https://auth.x.ai/authorize?client_id=zuse");
		expect(
			extractProviderLoginUrl(
				"Continue at https://login.example-corp.test/oauth2/authorize",
			),
		).toBe("https://login.example-corp.test/oauth2/authorize");
	});

	it("extracts URLs from ANSI text and OSC hyperlinks", () => {
		expect(
			extractProviderLoginUrl(
				"\u001b[32mhttps://auth.x.ai/authorize?state=abc\u001b[0m",
			),
		).toBe("https://auth.x.ai/authorize?state=abc");

		const osc =
			"\u001b]8;;https://sso.example.test/authorize?state=abc\u001b\\Open browser\u001b]8;;\u001b\\";
		expect(extractProviderLoginUrl(osc)).toBe(
			"https://sso.example.test/authorize?state=abc",
		);
		expect(stripLoginTerminalControls(osc)).toBe("Open browser");
	});

	it("rejects unsafe URLs while allowing loopback HTTP callbacks", () => {
		expect(extractProviderLoginUrl("javascript:alert(1)")).toBeNull();
		expect(
			extractProviderLoginUrl("Open http://login.example.test/authorize"),
		).toBeNull();
		expect(extractProviderLoginUrl("Open http://127.0.0.1:4567/callback")).toBe(
			"http://127.0.0.1:4567/callback",
		);
		expect(
			extractProviderLoginUrl("Open https://user:secret@example.test/login"),
		).toBeNull();
	});

	it("honors fixed-host provider policies", () => {
		const cursorPolicy = (url: URL) =>
			url.hostname === "cursor.com" || url.hostname.endsWith(".cursor.com");
		expect(
			extractProviderLoginUrl(
				"Open https://auth.cursor.com/login",
				cursorPolicy,
			),
		).toBe("https://auth.cursor.com/login");
		expect(
			extractProviderLoginUrl(
				"Open https://unrelated.example.test/login",
				cursorPolicy,
			),
		).toBeNull();
		expect(
			extractProviderLoginUrl(
				"Open https://unrelated.example.test/cursor.com/login",
				cursorPolicy,
			),
		).toBeNull();
	});
});
