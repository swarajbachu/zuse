import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";

describe("local connectivity helper", () => {
	test("does not require an unavailable desktop keychain access group", () => {
		const entitlements = readFileSync(
			new URL("../../build/entitlements.mac.plist", import.meta.url),
			"utf8",
		);

		expect(entitlements).not.toContain("<key>keychain-access-groups</key>");
	});

	test("replaces the active Bonjour listener before publishing another", () => {
		const source = readFileSync(
			new URL("../../native/local-connectivity/main.swift", import.meta.url),
			"utf8",
		);

		expect(source).toContain(
			"func start() {\n    retryWork?.cancel()\n    listener?.cancel()\n    listener = nil",
		);
		expect(source).toContain("func refreshInterfaces() {\n    start()\n  }");
	});
});
