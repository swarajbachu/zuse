import { describe, expect, it } from "vitest";
import {
	activateLocale,
	formatDate,
	formatNumber,
	formatRelativeTime,
	i18n,
	message,
	prepareLocale,
} from "../../src/index.ts";
import { availableLocales, resolveLocale } from "../../src/locales.ts";

const all = availableLocales(true);
describe("locale negotiation", () => {
	it.each([
		["zh-Hant-CN", "zh-Hant"],
		["zh-Hans-TW", "zh-Hans"],
		["zh-TW", "zh-Hant"],
		["zh-HK", "zh-Hant"],
		["zh-MO", "zh-Hant"],
		["zh-SG", "zh-Hans"],
		["zh", "zh-Hans"],
		["fr-CA", "fr"],
		["de-DE", "de"],
		["ja-JP", "ja"],
		["ko-KR", "ko"],
		["nonsense!", "en"],
	])("resolves %s to %s", (tag, expected) => {
		expect(resolveLocale("system", [tag], all)).toBe(expected);
	});
	it("tries subsequent OS preferences and honors a local override", () => {
		expect(resolveLocale("system", ["xx", "fr-CA"], all)).toBe("fr");
		expect(resolveLocale("de", ["ja-JP"], all)).toBe("de");
	});
	it("does not activate unreviewed languages in production", () => {
		expect(availableLocales()).toContain("en");
		expect(availableLocales()).not.toContain("en-XA");
		expect(resolveLocale("fr", ["fr-FR"], ["en"])).toBe("en");
	});
});
describe("offline resources and formatting", () => {
	it("loads a draft without HTTP and renders actual text", async () => {
		await prepareLocale("fr");
		await activateLocale("fr");
		expect(message("common:language")).toBe("Langue");
		expect(formatNumber(1234.5)).toBe(
			new Intl.NumberFormat("fr").format(1234.5),
		);
		expect(formatNumber(12, { style: "currency", currency: "USD" })).toBe(
			new Intl.NumberFormat("fr", {
				style: "currency",
				currency: "USD",
			}).format(12),
		);
		expect(formatRelativeTime(-1, "day")).toBe("hier");
		expect(formatDate(new Date(Number.NaN))).toBe("Date invalide");
		await activateLocale("en");
	});
	it("uses English fallback for a missing draft message and preserves plain text", async () => {
		await prepareLocale("fr");
		i18n.addResourceBundle("en", "test", {
			missing: "Hello {{name}}",
			items_one: "{{count}} item",
			items_other: "{{count}} items",
		});
		await activateLocale("fr");
		expect(i18n.t("test:missing", { name: "<script>&" })).toBe(
			"Hello <script>&",
		);
		expect(i18n.t("test:items", { count: 2 })).toBe("2 items");
		await activateLocale("en");
	});
	it("expands pseudo-language without damaging interpolation", async () => {
		await prepareLocale("en-XA");
		await activateLocale("en-XA");
		expect(message("common:language")).toMatch(/^⟦.*⟧$/);
		expect(message("common:language").length).toBeGreaterThan(
			"Language".length,
		);
		await activateLocale("en");
	});
});
