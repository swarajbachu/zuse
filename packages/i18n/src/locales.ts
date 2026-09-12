import type { DesktopLocale, LocalePreference } from "@zuse/contracts";
import names from "../locales/registry.json";
import review from "../review/desktop.json";

export const localeNames: Readonly<Record<DesktopLocale, string>> = names;
export const isLocale = (value: unknown): value is DesktopLocale =>
	typeof value === "string" && Object.hasOwn(localeNames, value);
export const isLocalePreference = (value: unknown): value is LocalePreference =>
	value === "system" || isLocale(value);
export const availableLocales = (preview = false): DesktopLocale[] =>
	(Object.keys(localeNames) as DesktopLocale[]).filter(
		(locale) =>
			preview || (locale !== "en-XA" && review[locale].status === "reviewed"),
	);

/** Respect explicit Chinese script before region. Try every OS preference before English. */
export function resolveLocale(
	preference: LocalePreference,
	systemLanguages: readonly string[],
	available = availableLocales(),
): DesktopLocale {
	if (preference !== "system" && available.includes(preference))
		return preference;
	for (const language of systemLanguages) {
		try {
			const parsed = new Intl.Locale(language.replaceAll("_", "-"));
			let locale: string = parsed.language;
			if (locale === "zh") {
				locale =
					parsed.script === "Hant"
						? "zh-Hant"
						: parsed.script === "Hans"
							? "zh-Hans"
							: ["TW", "HK", "MO"].includes(parsed.region ?? "")
								? "zh-Hant"
								: "zh-Hans";
			}
			if (isLocale(locale) && available.includes(locale)) return locale;
		} catch {
			/* Invalid OS tags do not prevent startup. */
		}
	}
	return "en";
}
