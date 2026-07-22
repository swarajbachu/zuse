import { createCipheriv, createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";

import { browserCookieImportInternals } from "../../src/browser-session-service.ts";

describe("browser cookie import internals", () => {
	it("reads Chromium 64-bit cookie timestamps without numeric overflow", () => {
		const db = new DatabaseSync(":memory:");
		db.exec(`
			CREATE TABLE cookies (
				host_key TEXT, name TEXT, value TEXT, encrypted_value BLOB,
				path TEXT, expires_utc INTEGER, is_secure INTEGER,
				is_httponly INTEGER, samesite INTEGER
			)
		`);
		db.prepare("INSERT INTO cookies VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
			".example.test",
			"session",
			"value",
			new Uint8Array(),
			"/",
			13_463_487_147_398_676n,
			1,
			1,
			1,
		);

		try {
			const rows = browserCookieImportInternals.readCookieRows(db);
			expect(rows[0]?.expires_utc).toBe(13_463_487_147_398_676n);
		} finally {
			db.close();
		}
	});

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
