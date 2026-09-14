import { describe, expect, it } from "vitest";
import {
	detectLocale,
	matchLanguage,
	parseLanguagePreferences,
} from "../../src/detection.ts";
import { resolveLocale } from "../../src/locales.ts";
import { websiteLocales } from "../../src/registry.ts";

describe("automatic language detection", () => {
	it("prefers supported languages over the country hint", () => {
		expect(detectLocale(["en-US", "fr"], websiteLocales, "FR")).toBe("en");
		expect(detectLocale(["ru", "ja-JP"], websiteLocales, "DE")).toBe("ja");
	});
	it("uses country only when no preferred language is supported", () => {
		expect(detectLocale(["ru"], websiteLocales, "FR")).toBe("fr");
		expect(detectLocale([], websiteLocales, "HK")).toBe("zh-Hant");
		expect(detectLocale([], websiteLocales, "sg")).toBe("zh-Hans");
		expect(detectLocale([], websiteLocales, "unknown")).toBe("en");
	});
	it("respects scripts before countries and handles malformed tags", () => {
		expect(matchLanguage("zh-Hans-TW")).toBe("zh-Hans");
		expect(matchLanguage("zh-Hant-CN")).toBe("zh-Hant");
		expect(matchLanguage("zh_HK")).toBe("zh-Hant");
		expect(matchLanguage("zh")).toBe("zh-Hans");
		expect(matchLanguage("../fr")).toBeUndefined();
	});
	it("never uses an unavailable language or overrides an explicit choice", () => {
		expect(detectLocale(["fr"], ["en"], "FR")).toBe("en");
		expect(resolveLocale("ko", ["fr"], websiteLocales, "DE")).toBe("ko");
	});
	it("orders HTTP preferences by quality, retaining tied order", () => {
		expect(
			parseLanguagePreferences("de;q=0.5, ja;q=1, fr;q=1, en;q=0"),
		).toEqual(["ja", "fr", "de"]);
		expect(parseLanguagePreferences("fr;q=nope, *;q=0.8, de;q=2, ja")).toEqual([
			"ja",
		]);
		expect(parseLanguagePreferences(null)).toEqual([]);
	});
});
