import type { WebsiteLocale } from "@zuse/i18n/registry";
import { loadWebsiteCatalog } from "@zuse/i18n/website/server";
import type { WebsiteCatalog } from "@zuse/i18n/website/types";
import { siteConfig } from "@/lib/seo";
import {
	DISCORD_URL,
	DOWNLOAD_URL,
	GITHUB_URL,
	INSTAGRAM_URL,
	X_URL,
} from "@/lib/site";

const createStructuredData = (
	locale: WebsiteLocale,
	messages: WebsiteCatalog,
) => ({
	"@context": "https://schema.org",
	"@graph": [
		{
			"@type": "Organization",
			"@id": `${siteConfig.url}/#organization`,
			name: siteConfig.name,
			url: siteConfig.url,
			logo: new URL(siteConfig.icon, siteConfig.url).toString(),
			sameAs: [GITHUB_URL, X_URL, INSTAGRAM_URL, DISCORD_URL],
		},
		{
			"@type": "WebSite",
			"@id": `${siteConfig.url}/#website`,
			name: siteConfig.name,
			url: siteConfig.url,
			description: messages["landing:meta_description"],
			publisher: { "@id": `${siteConfig.url}/#organization` },
			inLanguage: locale,
		},
		{
			"@type": "SoftwareApplication",
			"@id": `${siteConfig.url}/#software`,
			name: siteConfig.name,
			description: messages["landing:meta_description"],
			url: siteConfig.url,
			downloadUrl: new URL(DOWNLOAD_URL, siteConfig.url).toString(),
			codeRepository: GITHUB_URL,
			applicationCategory: "DeveloperApplication",
			operatingSystem: ["macOS", "Linux"],
			isAccessibleForFree: true,
			license: `${GITHUB_URL}/blob/main/LICENSE`,
			offers: {
				"@type": "Offer",
				price: "0",
				priceCurrency: "USD",
				availability: "https://schema.org/InStock",
			},
			featureList: [
				"landing:schema_parallel",
				"landing:schema_worktrees",
				"landing:schema_environments",
				"landing:schema_tools",
				"landing:schema_subscriptions",
			].map((key) => messages[key as keyof WebsiteCatalog]),
			publisher: { "@id": `${siteConfig.url}/#organization` },
		},
	],
});

export async function HomepageStructuredData({
	locale = "en",
}: {
	locale?: WebsiteLocale;
}) {
	const structuredData = createStructuredData(
		locale,
		await loadWebsiteCatalog(locale),
	);
	return (
		<script
			type="application/ld+json"
			// biome-ignore lint/security/noDangerouslySetInnerHtml: The payload is static, trusted schema data and escapes opening tags.
			dangerouslySetInnerHTML={{
				__html: JSON.stringify(structuredData).replaceAll("<", "\\u003c"),
			}}
		/>
	);
}
