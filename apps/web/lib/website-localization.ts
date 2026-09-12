import {
	type WebsiteLocale,
	websiteLocales,
	websitePath,
} from "@zuse/i18n/registry";
import { siteConfig } from "./seo";
export const websiteAlternates = () =>
	Object.fromEntries([
		...websiteLocales.map((locale) => [
			locale,
			new URL(websitePath(locale), siteConfig.url).toString(),
		]),
		["x-default", new URL("/", siteConfig.url).toString()],
	]);
export const openGraphLocale = (locale: WebsiteLocale) =>
	({
		en: "en_US",
		fr: "fr_FR",
		de: "de_DE",
		"zh-Hans": "zh_CN",
		"zh-Hant": "zh_TW",
		ja: "ja_JP",
		ko: "ko_KR",
	})[locale];
