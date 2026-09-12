// Generated. Website resources are server-loaded; client imports must be type-only.
import type demo from "../../locales/en/website/demo.json";
import type faq from "../../locales/en/website/faq.json";
import type landing from "../../locales/en/website/landing.json";
import type navigation from "../../locales/en/website/navigation.json";
import type showcase from "../../locales/en/website/showcase.json";
import type { WebsiteLocale } from "../registry.ts";
export type WebsiteMessageKey =
	| `demo:${keyof typeof demo}`
	| `faq:${keyof typeof faq}`
	| `landing:${keyof typeof landing}`
	| `navigation:${keyof typeof navigation}`
	| `showcase:${keyof typeof showcase}`;
export type WebsiteCatalog = Readonly<Record<WebsiteMessageKey, string>>;
export const websiteLoaders: Record<
	WebsiteLocale,
	() => Promise<WebsiteCatalog>
> = {
	en: async () => {
		const parts = await Promise.all([
			import("../../locales/en/website/demo.json"),
			import("../../locales/en/website/faq.json"),
			import("../../locales/en/website/landing.json"),
			import("../../locales/en/website/navigation.json"),
			import("../../locales/en/website/showcase.json"),
		]);
		return Object.fromEntries(
			parts.flatMap((part, i) =>
				Object.entries(part.default).map(([key, value]) => [
					["demo", "faq", "landing", "navigation", "showcase"][i] + ":" + key,
					value,
				]),
			),
		) as WebsiteCatalog;
	},
	fr: async () => {
		const parts = await Promise.all([
			import("../../locales/fr/website/demo.json"),
			import("../../locales/fr/website/faq.json"),
			import("../../locales/fr/website/landing.json"),
			import("../../locales/fr/website/navigation.json"),
			import("../../locales/fr/website/showcase.json"),
		]);
		return Object.fromEntries(
			parts.flatMap((part, i) =>
				Object.entries(part.default).map(([key, value]) => [
					["demo", "faq", "landing", "navigation", "showcase"][i] + ":" + key,
					value,
				]),
			),
		) as WebsiteCatalog;
	},
	de: async () => {
		const parts = await Promise.all([
			import("../../locales/de/website/demo.json"),
			import("../../locales/de/website/faq.json"),
			import("../../locales/de/website/landing.json"),
			import("../../locales/de/website/navigation.json"),
			import("../../locales/de/website/showcase.json"),
		]);
		return Object.fromEntries(
			parts.flatMap((part, i) =>
				Object.entries(part.default).map(([key, value]) => [
					["demo", "faq", "landing", "navigation", "showcase"][i] + ":" + key,
					value,
				]),
			),
		) as WebsiteCatalog;
	},
	"zh-Hans": async () => {
		const parts = await Promise.all([
			import("../../locales/zh-Hans/website/demo.json"),
			import("../../locales/zh-Hans/website/faq.json"),
			import("../../locales/zh-Hans/website/landing.json"),
			import("../../locales/zh-Hans/website/navigation.json"),
			import("../../locales/zh-Hans/website/showcase.json"),
		]);
		return Object.fromEntries(
			parts.flatMap((part, i) =>
				Object.entries(part.default).map(([key, value]) => [
					["demo", "faq", "landing", "navigation", "showcase"][i] + ":" + key,
					value,
				]),
			),
		) as WebsiteCatalog;
	},
	"zh-Hant": async () => {
		const parts = await Promise.all([
			import("../../locales/zh-Hant/website/demo.json"),
			import("../../locales/zh-Hant/website/faq.json"),
			import("../../locales/zh-Hant/website/landing.json"),
			import("../../locales/zh-Hant/website/navigation.json"),
			import("../../locales/zh-Hant/website/showcase.json"),
		]);
		return Object.fromEntries(
			parts.flatMap((part, i) =>
				Object.entries(part.default).map(([key, value]) => [
					["demo", "faq", "landing", "navigation", "showcase"][i] + ":" + key,
					value,
				]),
			),
		) as WebsiteCatalog;
	},
	ja: async () => {
		const parts = await Promise.all([
			import("../../locales/ja/website/demo.json"),
			import("../../locales/ja/website/faq.json"),
			import("../../locales/ja/website/landing.json"),
			import("../../locales/ja/website/navigation.json"),
			import("../../locales/ja/website/showcase.json"),
		]);
		return Object.fromEntries(
			parts.flatMap((part, i) =>
				Object.entries(part.default).map(([key, value]) => [
					["demo", "faq", "landing", "navigation", "showcase"][i] + ":" + key,
					value,
				]),
			),
		) as WebsiteCatalog;
	},
	ko: async () => {
		const parts = await Promise.all([
			import("../../locales/ko/website/demo.json"),
			import("../../locales/ko/website/faq.json"),
			import("../../locales/ko/website/landing.json"),
			import("../../locales/ko/website/navigation.json"),
			import("../../locales/ko/website/showcase.json"),
		]);
		return Object.fromEntries(
			parts.flatMap((part, i) =>
				Object.entries(part.default).map(([key, value]) => [
					["demo", "faq", "landing", "navigation", "showcase"][i] + ":" + key,
					value,
				]),
			),
		) as WebsiteCatalog;
	},
};
