import { afterEach, describe, expect, it } from "vitest";
import { activateLocale, message, prepareLocale } from "../../src/index.ts";

afterEach(async () => {
	await activateLocale("en");
});

describe("Pi interface localization", () => {
	it.each([
		["fr", "Autorisations Pi"],
		["de", "Pi-Berechtigungen"],
		["zh-Hans", "Pi 权限"],
		["zh-Hant", "Pi 權限"],
		["ja", "Pi の権限"],
		["ko", "Pi 권한"],
	] as const)("loads Pi messages offline in %s", async (locale, permissions) => {
		await prepareLocale(locale, ["providers", "chat", "shell"]);
		await activateLocale(locale);
		expect(message("chat:pi_permissions")).toBe(permissions);
		expect(message("providers:pi_setup_hint")).toContain("<part0>pi</part0>");
		expect(message("providers:pi_setup_hint")).toContain(
			"<part1>/login</part1>",
		);
		expect(message("providers:pi_binary_help")).toContain("PATH");
		expect(message("chat:question_cancelled")).not.toBe("Question cancelled.");
		expect(message("chat:question_timed_out")).not.toBe("Question timed out.");
	});

	it("switches Pi labels back to English without reloading", async () => {
		await prepareLocale("en", ["providers", "chat"]);
		await prepareLocale("ja", ["providers", "chat"]);
		await activateLocale("ja");
		expect(message("providers:pi_binary_path")).toBe("Pi 実行ファイルのパス");
		await activateLocale("en");
		expect(message("providers:pi_binary_path")).toBe("Pi binary path");
		expect(message("chat:pi_permissions")).toBe("Pi permissions");
	});
});
