"use client";
import { createInstance } from "i18next";
import {
	createContext,
	type ReactElement,
	type ReactNode,
	useCallback,
	useContext,
	useMemo,
} from "react";
import { I18nextProvider, Trans, useTranslation } from "react-i18next";
import type {
	WebsiteCatalog,
	WebsiteMessageKey,
} from "../generated/website.ts";
import type { WebsiteLocale } from "../registry.ts";
export type WebsiteMessage = (
	key: WebsiteMessageKey,
	values?: Readonly<Record<string, string | number>>,
) => string;
const LocaleContext = createContext<WebsiteLocale>("en");
export function WebsiteProvider({
	locale,
	messages,
	children,
}: {
	locale: WebsiteLocale;
	messages: WebsiteCatalog;
	children: ReactNode;
}) {
	const instance = useMemo(() => {
		const next = createInstance();
		void next.init({
			lng: locale,
			resources: { [locale]: { website: messages } },
			ns: ["website"],
			defaultNS: "website",
			nsSeparator: false,
			keySeparator: false,
			fallbackLng: false,
			initImmediate: false,
			showSupportNotice: false,
			interpolation: { escapeValue: false },
		});
		return next;
	}, [locale, messages]);
	return (
		<LocaleContext.Provider value={locale}>
			<I18nextProvider i18n={instance}>{children}</I18nextProvider>
		</LocaleContext.Provider>
	);
}
export function useWebsiteMessages() {
	const { t } = useTranslation("website");
	const locale = useContext(LocaleContext);
	const message: WebsiteMessage = useCallback(
		(key, values) => String(t(key, values)),
		[t],
	);
	return { message, locale };
}
export function WebsiteRichMessage({
	id,
	values,
	components,
}: {
	id: WebsiteMessageKey;
	values?: Readonly<Record<string, string | number>>;
	components: Readonly<Record<string, ReactElement>>;
}) {
	return (
		<Trans
			i18nKey={id}
			values={values}
			components={components}
			shouldUnescape={false}
		/>
	);
}
