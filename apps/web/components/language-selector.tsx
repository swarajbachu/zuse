"use client";
import {
	isWebsiteLocale,
	languageNames,
	websiteLocales,
	websitePath,
} from "@zuse/i18n/registry";
import { useWebsiteMessages } from "@zuse/i18n/website/react";
export function LanguageSelector() {
	const { message: t, locale } = useWebsiteMessages();
	return (
		<select
			aria-label={t("navigation:language")}
			value={locale}
			onChange={(event) => {
				if (isWebsiteLocale(event.target.value))
					window.location.assign(
						websitePath(event.target.value) + window.location.hash,
					);
			}}
			className="h-7 max-w-28 rounded-md border border-border bg-card px-1.5 text-xs text-heading focus-visible:outline-2 focus-visible:outline-primary"
		>
			{websiteLocales.map((value) => (
				<option key={value} value={value} lang={value}>
					{languageNames[value]}
				</option>
			))}
		</select>
	);
}
