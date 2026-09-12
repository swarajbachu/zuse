import type { DesktopLocale } from "@zuse/contracts";
import { type BackendModule, createInstance, type i18n as I18n } from "i18next";
import common from "../locales/en/desktop/common.json";
import {
	loaders,
	type MessageKey,
	type Namespace,
} from "./generated/desktop.ts";

export type { MessageKey, Namespace } from "./generated/desktop.ts";
export {
	availableLocales,
	isLocale,
	isLocalePreference,
	localeNames,
	resolveLocale,
} from "./locales.ts";

export const i18n: I18n = createInstance();
const backend: BackendModule = {
	type: "backend",
	init() {},
	read(language, namespace, callback) {
		const load = loaders[language as DesktopLocale]?.[namespace as Namespace];
		if (!load) {
			callback(new Error("Unsupported translation resource"), false);
			return;
		}
		void load().then(
			(resource) => callback(null, resource.default),
			(error) => callback(error, false),
		);
	},
};
void i18n.use(backend).init({
	showSupportNotice: false,
	lng: "en",
	fallbackLng: "en",
	defaultNS: "common",
	ns: ["common"],
	resources: { en: { common } },
	partialBundledLanguages: true,
	initImmediate: false,
	keySeparator: false,
	returnEmptyString: false,
	// These are plain strings passed to React or native Electron labels. Both render text,
	// not HTML. HTML escaping here would display literal entities in native controls.
	interpolation: { escapeValue: false },
});

export type MessageValues = Readonly<Record<string, string | number>>;
export function message(key: MessageKey, values?: MessageValues): string {
	return String(i18n.t(key, values));
}

/** Prepare off-screen. The caller commits only the most recent requested locale. */
export async function prepareLocale(
	locale: DesktopLocale,
	namespaces: readonly Namespace[] = ["common"],
): Promise<void> {
	await Promise.all(
		[locale, "en" as const].flatMap((language) =>
			namespaces.map(async (namespace) => {
				if (i18n.hasResourceBundle(language, namespace)) return;
				const resource = await loaders[language][namespace]();
				i18n.addResourceBundle(language, namespace, resource.default);
			}),
		),
	);
}
export async function activateLocale(locale: DesktopLocale): Promise<void> {
	await i18n.changeLanguage(locale);
}

const numberFormats = new Map<string, Intl.NumberFormat>();
const dateFormats = new Map<string, Intl.DateTimeFormat>();
const relativeFormats = new Map<string, Intl.RelativeTimeFormat>();
function cached<T>(
	cache: Map<string, T>,
	options: object,
	create: (locale: string) => T,
): T {
	const locale = i18n.language === "en-XA" ? "en" : i18n.language || "en";
	const key = JSON.stringify([
		locale,
		Object.entries(options).sort(([a], [b]) => a.localeCompare(b)),
	]);
	let formatter = cache.get(key);
	if (!formatter) {
		formatter = create(locale);
		if (cache.size >= 100) cache.delete(cache.keys().next().value ?? "");
		cache.set(key, formatter);
	}
	return formatter;
}
export const formatNumber = (
	value: number,
	options: Intl.NumberFormatOptions = {},
): string =>
	cached(
		numberFormats,
		options,
		(locale) => new Intl.NumberFormat(locale, options),
	).format(value);
export function formatDate(
	value: Date | number,
	options: Intl.DateTimeFormatOptions = {},
): string {
	const date = typeof value === "number" ? new Date(value) : value;
	if (Number.isNaN(date.getTime())) return message("common:invalidDate");
	return cached(
		dateFormats,
		options,
		(locale) => new Intl.DateTimeFormat(locale, options),
	).format(date);
}

export const formatRelativeTime = (
	value: number,
	unit: Intl.RelativeTimeFormatUnit,
	options: Intl.RelativeTimeFormatOptions = { numeric: "auto" },
): string =>
	cached(
		relativeFormats,
		options,
		(locale) => new Intl.RelativeTimeFormat(locale, options),
	).format(value, unit);
