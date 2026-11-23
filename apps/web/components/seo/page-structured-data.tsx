import { JsonLd } from "@/components/seo/json-ld";
import { siteConfig } from "@/lib/seo";

export function createPageStructuredData({
	type = "WebPage",
	path,
	name,
	description,
}: {
	type?: "WebPage" | "CollectionPage";
	path: string;
	name: string;
	description: string;
}) {
	const url = new URL(path, siteConfig.url).toString();
	return {
		"@context": "https://schema.org",
		"@graph": [
			{
				"@type": type,
				"@id": `${url}#webpage`,
				url,
				name,
				description,
				inLanguage: "en",
				isPartOf: { "@id": `${siteConfig.url}/#website` },
			},
			{
				"@type": "BreadcrumbList",
				itemListElement: [
					{
						"@type": "ListItem",
						position: 1,
						name: siteConfig.name,
						item: siteConfig.url,
					},
					{ "@type": "ListItem", position: 2, name, item: url },
				],
			},
		],
	};
}

/** WebPage or CollectionPage plus breadcrumb JSON-LD for a top-level page. */
export function PageStructuredData(
	props: Parameters<typeof createPageStructuredData>[0],
) {
	return <JsonLd data={createPageStructuredData(props)} />;
}
