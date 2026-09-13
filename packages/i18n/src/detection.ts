import { type Locale, type WebsiteLocale, websiteLocales } from "./registry.ts";

/** Country is a last-resort hint, never an override for a language preference. */
const countryLanguages: Readonly<Record<string, WebsiteLocale>> = {
	FR: "fr",
	MC: "fr",
	DE: "de",
	AT: "de",
	LI: "de",
	CN: "zh-Hans",
	SG: "zh-Hans",
	TW: "zh-Hant",
	HK: "zh-Hant",
	MO: "zh-Hant",
	JP: "ja",
	KR: "ko",
};

export function matchLanguage(language: string): WebsiteLocale | undefined {
	try {
		const parsed = new Intl.Locale(language.replaceAll("_", "-"));
		if (parsed.language === "zh") {
			if (parsed.script === "Hant") return "zh-Hant";
			if (parsed.script === "Hans") return "zh-Hans";
			return ["TW", "HK", "MO"].includes(parsed.region ?? "")
				? "zh-Hant"
				: "zh-Hans";
		}
		return websiteLocales.find((locale) => locale === parsed.language);
	} catch {
		return undefined;
	}
}

export function detectLocale(
	languages: readonly string[],
	available: readonly Locale[] = websiteLocales,
	country?: string | null,
): Locale {
	for (const language of languages) {
		const locale = matchLanguage(language);
		if (locale && available.includes(locale)) return locale;
	}
	const hint = countryLanguages[country?.toUpperCase() ?? ""];
	return hint && available.includes(hint) ? hint : "en";
}

/** Preserve preference order for equal weights and ignore malformed/disabled ranges. */
export function parseLanguagePreferences(header: string | null): string[] {
	return (header ?? "")
		.slice(0, 4096)
		.split(",")
		.slice(0, 32)
		.map((entry) => {
			const [language, ...parameters] = entry.trim().split(";");
			const quality = parameters.find((parameter) =>
				/^\s*q\s*=/i.test(parameter),
			);
			const value = quality ? quality.split("=")[1]?.trim() : "1";
			const weight =
				value && /^(?:0(?:\.\d{0,3})?|1(?:\.0{0,3})?)$/.test(value)
					? Number(value)
					: 0;
			return { language: language?.trim() ?? "", weight };
		})
		.filter(
			({ language, weight }) =>
				weight > 0 && language.length > 0 && language !== "*",
		)
		.sort((a, b) => b.weight - a.weight)
		.map(({ language }) => language);
}
