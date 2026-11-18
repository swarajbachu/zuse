import { describe, expect, it } from "vitest";
import {
	hasSavedWebsiteLanguage,
	suggestWebsiteLanguage,
} from "./language-preference";

describe("suggestWebsiteLanguage", () => {
	it("suggests the first supported non-English browser language", () => {
		expect(suggestWebsiteLanguage(["fr-CA", "en"])).toBe("fr");
		expect(suggestWebsiteLanguage(["ru", "de-AT"])).toBe("de");
		expect(suggestWebsiteLanguage(["zh-TW"])).toBe("zh-Hant");
		expect(suggestWebsiteLanguage(["zh"])).toBe("zh-Hans");
	});

	it("suggests nothing when English is preferred or nothing matches", () => {
		expect(suggestWebsiteLanguage(["en-GB", "fr"])).toBeNull();
		expect(suggestWebsiteLanguage(["ru", "es"])).toBeNull();
		expect(suggestWebsiteLanguage([])).toBeNull();
	});
});

describe("hasSavedWebsiteLanguage", () => {
	it("detects a valid saved language and ignores corrupt values", () => {
		expect(hasSavedWebsiteLanguage("a=b; zuse-language=ja")).toBe(true);
		expect(hasSavedWebsiteLanguage("zuse-language=en")).toBe(true);
		expect(hasSavedWebsiteLanguage("zuse-language=en-XA")).toBe(false);
		expect(hasSavedWebsiteLanguage("zuse-language=")).toBe(false);
		expect(hasSavedWebsiteLanguage("")).toBe(false);
	});
});
