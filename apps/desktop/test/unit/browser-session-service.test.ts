import { createCipheriv, createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

import { browserCookieImportInternals } from "../../src/browser-session-service.ts";

describe("browser cookie import internals", () => {
	it("ignores nested LaunchServices placeholders when reading the HTTPS handler", () => {
		const launchServices = `(
			{
				LSHandlerPreferredVersions = {
					LSHandlerRoleAll = "-";
				};
				LSHandlerRoleAll = "com.example.browser";
				LSHandlerURLScheme = https;
			},
		)`;

		expect(
			browserCookieImportInternals.parseDefaultHandlerBundle(launchServices),
		).toBe("com.example.browser");
	});

	it("rejects a placeholder-only HTTPS handler", () => {
		const launchServices = `(
			{
				LSHandlerRoleAll = "-";
				LSHandlerURLScheme = https;
			},
		)`;

		expect(
			browserCookieImportInternals.parseDefaultHandlerBundle(launchServices),
		).toBeNull();
	});

	it("decrypts a host-bound Chromium cookie fixture", () => {
		const host = ".example.test";
		const key = Buffer.from("0123456789abcdef");
		const cipher = createCipheriv("aes-128-cbc", key, Buffer.alloc(16, " "));
		const encrypted = Buffer.concat([
			Buffer.from("v10"),
			cipher.update(
				Buffer.concat([
					createHash("sha256").update(host).digest(),
					Buffer.from("session-value"),
				]),
			),
			cipher.final(),
		]);

		expect(
			browserCookieImportInternals.decryptCookie(encrypted, key, host),
		).toBe("session-value");
		expect(
			browserCookieImportInternals.decryptCookie(encrypted, key, "wrong.test"),
		).not.toBe("session-value");
	});

	it("derives generic safe-storage service candidates without duplicates", () => {
		expect(
			browserCookieImportInternals.safeStorageServiceCandidates(
				"Example Browser",
			),
		).toEqual([
			"Example Browser Safe Storage",
			"Example Safe Storage",
			"Browser Safe Storage",
		]);
	});
});
