import { websiteLocales, websitePath } from "@zuse/i18n/registry";
import type { MetadataRoute } from "next";
import { LEGAL_PAGES } from "@/lib/legal-pages";
import { siteConfig } from "@/lib/seo";
import { websiteAlternates } from "@/lib/website-localization";

export default function sitemap(): MetadataRoute.Sitemap {
	const now = new Date();
	return [
		...websiteLocales.map((locale) => ({
			url: new URL(websitePath(locale), siteConfig.url).toString(),
			lastModified: now,
			changeFrequency: "weekly" as const,
			priority: locale === "en" ? 1 : 0.9,
			alternates: { languages: websiteAlternates() },
		})),
		{
			url: `${siteConfig.url}/developers`,
			lastModified: now,
			changeFrequency: "monthly",
			priority: 0.8,
		},
		{
			url: `${siteConfig.url}/changelog`,
			lastModified: now,
			changeFrequency: "weekly",
			priority: 0.8,
		},
		{
			url: `${siteConfig.url}/blog`,
			lastModified: now,
			changeFrequency: "weekly",
			priority: 0.7,
		},
		...LEGAL_PAGES.map(({ path }) => ({
			url: `${siteConfig.url}${path}`,
			lastModified: now,
			changeFrequency: "yearly" as const,
			priority: 0.2,
		})),
	];
}
