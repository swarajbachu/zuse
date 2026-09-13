import type { MetadataRoute } from "next";
import { LEGAL_PAGES } from "@/lib/legal-pages";
import { siteConfig } from "@/lib/seo";

export default function sitemap(): MetadataRoute.Sitemap {
	const now = new Date();
	return [
		{
			url: siteConfig.url,
			lastModified: now,
			changeFrequency: "weekly",
			priority: 1,
		},
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
