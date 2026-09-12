import names from "../locales/registry.json";
export type Locale = keyof typeof names;
export type WebsiteLocale = Exclude<Locale, "en-XA">;
export const languageNames = names;
export const websiteLocales = Object.keys(names).filter(
	(locale): locale is WebsiteLocale => locale !== "en-XA",
);
export const isWebsiteLocale = (value: string): value is WebsiteLocale =>
	websiteLocales.includes(value as WebsiteLocale);
export const websitePath = (locale: WebsiteLocale) =>
	locale === "en" ? "/" : `/${locale}`;
