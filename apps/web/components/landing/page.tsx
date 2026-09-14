import {
	type WebsiteLocale,
	websiteLocales,
	websitePath,
} from "@zuse/i18n/registry";
import { loadWebsiteCatalog } from "@zuse/i18n/website/server";
import { FAQ } from "@/components/faq";
import { Hero } from "@/components/landing/hero";
import { HorizontalLine } from "@/components/landing/line";
import { ProductShowcase } from "@/components/landing/product-showcase";
import { HomepageStructuredData } from "@/components/seo/homepage-structured-data";
import { getSEO } from "@/lib/seo";
import { openGraphLocale, websiteAlternates } from "@/lib/website-localization";

export async function getLandingMetadata(locale: WebsiteLocale) {
	const messages = await loadWebsiteCatalog(locale);
	const metadata = getSEO({
		absoluteTitle: messages["landing:meta_title"],
		description: messages["landing:meta_description"],
		path: websitePath(locale),
	});
	return {
		...metadata,
		alternates: {
			canonical: websitePath(locale),
			languages: websiteAlternates(),
		},
		openGraph: {
			...metadata.openGraph,
			locale: openGraphLocale(locale),
			alternateLocale: websiteLocales
				.filter((value) => value !== locale)
				.map(openGraphLocale),
		},
	};
}
export function LandingPage({ locale }: { locale: WebsiteLocale }) {
	return (
		<main>
			<HomepageStructuredData locale={locale} />
			<Hero />
			<ProductShowcase />
			<HorizontalLine />
			<FAQ />
		</main>
	);
}
