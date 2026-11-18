"use client";

import { IconX } from "@tabler/icons-react";
import {
	languageNames,
	type WebsiteLocale,
	websitePath,
} from "@zuse/i18n/registry";
import { useWebsiteMessages } from "@zuse/i18n/website/react";
import Link from "next/link";
import { useEffect, useState } from "react";
import {
	hasSavedWebsiteLanguage,
	rememberWebsiteLanguage,
	suggestWebsiteLanguage,
} from "@/lib/language-preference";

/**
 * Offers the visitor's browser language on the English homepage. It is a plain
 * link, never a redirect: crawlers and every visitor get the same English page.
 * Dismissing it, or choosing a language in the selector, saves the choice so it
 * does not return.
 */
export function LanguageSuggestion() {
	const { message: t, locale } = useWebsiteMessages();
	const [suggested, setSuggested] = useState<WebsiteLocale | null>(null);

	useEffect(() => {
		if (locale !== "en" || hasSavedWebsiteLanguage(document.cookie)) return;
		setSuggested(
			suggestWebsiteLanguage(
				navigator.languages?.length
					? navigator.languages
					: [navigator.language],
			),
		);
	}, [locale]);

	if (!suggested) return null;
	return (
		<aside
			aria-label={t("navigation:language")}
			className="bg-card border-border text-heading fixed right-4 bottom-4 left-4 z-50 flex items-center justify-between gap-3 rounded-lg border px-4 py-3 text-sm shadow-lg sm:right-auto sm:max-w-sm"
		>
			<p>
				{t("navigation:language_suggestion")}{" "}
				<Link
					href={websitePath(suggested)}
					hrefLang={suggested}
					lang={suggested}
					onClick={() => rememberWebsiteLanguage(suggested)}
					className="text-primary font-medium underline underline-offset-3"
				>
					{languageNames[suggested]}
				</Link>
			</p>
			<button
				type="button"
				aria-label={t("navigation:language_suggestion_dismiss")}
				onClick={() => {
					rememberWebsiteLanguage("en");
					setSuggested(null);
				}}
				className="text-muted-foreground hover:text-heading focus-visible:ring-heading/60 relative flex size-6 shrink-0 items-center justify-center rounded-md after:absolute after:-inset-2 focus-visible:ring-2 focus-visible:outline-none"
			>
				<IconX className="size-4" aria-hidden="true" />
			</button>
		</aside>
	);
}
