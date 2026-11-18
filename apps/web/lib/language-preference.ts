import { detectLocale } from "@zuse/i18n/detection";
import {
	isWebsiteLocale,
	type WebsiteLocale,
	websiteLocales,
} from "@zuse/i18n/registry";

export const LANGUAGE_COOKIE = "zuse-language";
export const LANGUAGE_COOKIE_MAX_AGE = 60 * 60 * 24 * 365;

/**
 * The non-English website language a visitor's browser prefers, if any.
 * Used only to offer a link on `/`; it never changes the page that is served.
 */
export function suggestWebsiteLanguage(
	browserLanguages: readonly string[],
): WebsiteLocale | null {
	const detected = detectLocale(browserLanguages, websiteLocales, null);
	return isWebsiteLocale(detected) && detected !== "en" ? detected : null;
}

export function hasSavedWebsiteLanguage(cookieHeader: string): boolean {
	return cookieHeader.split(";").some((part) => {
		const [name, value] = part.trim().split("=");
		return name === LANGUAGE_COOKIE && !!value && isWebsiteLocale(value);
	});
}

export function rememberWebsiteLanguage(locale: WebsiteLocale) {
	try {
		// biome-ignore lint/suspicious/noDocumentCookie: synchronous persistence must finish before navigation; supported by all target browsers.
		document.cookie = `${LANGUAGE_COOKIE}=${locale}; Path=/; Max-Age=${LANGUAGE_COOKIE_MAX_AGE}; SameSite=Lax${location.protocol === "https:" ? "; Secure" : ""}`;
	} catch {}
}
