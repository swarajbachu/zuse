import { siteConfig } from "@/lib/seo";
export function ArticleStructuredData({
	title,
	description,
	url,
	image,
	date,
	updated,
	author,
}: {
	title: string;
	description?: string;
	url: string;
	image: string;
	date: Date;
	updated?: Date;
	author: string;
}) {
	const absoluteUrl = new URL(url, siteConfig.url).toString();
	const data = {
		"@context": "https://schema.org",
		"@graph": [
			{
				"@type": "BlogPosting",
				"@id": `${absoluteUrl}#article`,
				headline: title,
				description,
				url: absoluteUrl,
				mainEntityOfPage: absoluteUrl,
				datePublished: date.toISOString(),
				dateModified: updated?.toISOString(),
				image: new URL(image, siteConfig.url).toString(),
				author: { "@type": "Organization", name: author, url: siteConfig.url },
				publisher: {
					"@type": "Organization",
					name: "Zuse",
					url: siteConfig.url,
					logo: {
						"@type": "ImageObject",
						url: new URL(siteConfig.icon, siteConfig.url).toString(),
					},
				},
				inLanguage: "en",
			},
			{
				"@type": "BreadcrumbList",
				itemListElement: [
					{
						"@type": "ListItem",
						position: 1,
						name: "Journal",
						item: `${siteConfig.url}/blog`,
					},
					{ "@type": "ListItem", position: 2, name: title, item: absoluteUrl },
				],
			},
		],
	};
	return (
		<script
			type="application/ld+json"
			// biome-ignore lint/security/noDangerouslySetInnerHtml: Trusted article metadata serialized as JSON with opening tags escaped.
			dangerouslySetInnerHTML={{
				__html: JSON.stringify(data).replace(/</g, "\\u003c"),
			}}
		/>
	);
}
