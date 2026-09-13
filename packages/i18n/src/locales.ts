import type { DesktopLocale, LocalePreference } from "@zuse/contracts";
import names from "../locales/registry.json";
import review from "../review/desktop.json";
import { detectLocale } from "./detection.ts";

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
	country?: string,
): DesktopLocale {
	if (preference !== "system" && available.includes(preference))
		return preference;
	return detectLocale(systemLanguages, available, country);
}
