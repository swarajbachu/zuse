import type { MetadataRoute } from "next";
import { SITE_URL } from "@/lib/layout.shared";
import { source } from "@/lib/source";

export default function sitemap(): MetadataRoute.Sitemap {
	return source.getPages().map((page) => ({
		url: `${SITE_URL}${page.url}`,
		changeFrequency: "weekly",
		priority: page.url === "/start" ? 1 : 0.7,
	}));
}
