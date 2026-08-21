import type { MetadataRoute } from "next";
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
		{
			url: `${siteConfig.url}/privacy`,
			lastModified: now,
			changeFrequency: "yearly",
			priority: 0.2,
		},
	];
}
