import { websiteLocales, websitePath } from "@zuse/i18n/registry";
import type { MetadataRoute } from "next";
import { LEGAL_PAGES } from "@/lib/legal-pages";
import { siteConfig } from "@/lib/seo";
import { blog } from "@/lib/source";
import { websiteAlternates } from "@/lib/website-localization";

export default function sitemap(): MetadataRoute.Sitemap {
	// Omit lastModified until content maintains reliable modification dates.
	// A request/build timestamp would incorrectly claim every page just changed.
	return [
		...websiteLocales.map((locale) => ({
			url: new URL(websitePath(locale), siteConfig.url).toString(),
			alternates: { languages: websiteAlternates() },
		})),
		...["/developers", "/changelog", "/blog", "/pricing"].map((path) => ({
			url: new URL(path, siteConfig.url).toString(),
		})),
		...blog.getPages().map((page) => ({
			url: new URL(page.url, siteConfig.url).toString(),
		})),
		...LEGAL_PAGES.map(({ path }) => ({
			url: new URL(path, siteConfig.url).toString(),
		})),
	];
}
