"use client";

import {
	isWebsiteLocale,
	languageNames,
	type WebsiteLocale,
	websiteLocales,
	websitePath,
} from "@zuse/i18n/registry";
import { useWebsiteMessages } from "@zuse/i18n/website/react";
import { useId } from "react";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { rememberWebsiteLanguage } from "@/lib/language-preference";

const shortNames: Record<WebsiteLocale, string> = {
	en: "EN",
	fr: "FR",
	de: "DE",
	"zh-Hans": "简中",
	"zh-Hant": "繁中",
	ja: "JA",
	ko: "KO",
};

export function LanguageSelector() {
	const { message: t, locale } = useWebsiteMessages();
	const descriptionId = useId();
	return (
		<Select
			value={locale}
			items={languageNames}
			onValueChange={(value) => {
				if (value && isWebsiteLocale(value)) {
					rememberWebsiteLanguage(value);
					if (value !== locale)
						window.location.assign(websitePath(value) + window.location.hash);
				}
			}}
		>
			<SelectTrigger
				aria-label={t("navigation:language")}
				aria-describedby={descriptionId}
				title={languageNames[locale]}
				className="h-6 min-h-6 w-12 px-1.5 text-[11px]"
			>
				<SelectValue>{shortNames[locale]}</SelectValue>
				<span id={descriptionId} className="sr-only" lang={locale}>
					{languageNames[locale]}
				</span>
			</SelectTrigger>
			<SelectContent>
				{websiteLocales.map((value) => (
					<SelectItem key={value} value={value} lang={value}>
						{languageNames[value]}
					</SelectItem>
				))}
			</SelectContent>
		</Select>
	);
}
