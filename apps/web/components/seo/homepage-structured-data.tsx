import { siteConfig } from "@/lib/seo";
import {
	DISCORD_URL,
	DOWNLOAD_URL,
	GITHUB_URL,
	INSTAGRAM_URL,
	X_URL,
} from "@/lib/site";

const structuredData = {
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
			description: siteConfig.description,
			publisher: { "@id": `${siteConfig.url}/#organization` },
			inLanguage: "en-US",
		},
		{
			"@type": "SoftwareApplication",
			"@id": `${siteConfig.url}/#software`,
			name: siteConfig.name,
			description: siteConfig.description,
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
				"Run multiple coding agents from one workspace",
				"Isolated Git worktrees for parallel agent runs",
				"Local and cloud execution environments",
				"Built-in diff, terminal, browser, and pull-request review",
				"Bring your existing model subscriptions",
			],
			publisher: { "@id": `${siteConfig.url}/#organization` },
		},
	],
};

export function HomepageStructuredData() {
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
