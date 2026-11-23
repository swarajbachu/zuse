import { SITE_URL } from "@/lib/layout.shared";
import {
	DOCS_OG_IMAGE,
	DOCS_SITE_NAME,
	PRODUCT_CANONICAL_URL,
} from "@/lib/seo";

export interface DocsCrumb {
	name: string;
	path: string;
}

const absolute = (path: string) => new URL(path, SITE_URL).toString();

/** TechArticle plus BreadcrumbList for one documentation page. */
export function createDocsStructuredData({
	title,
	description,
	path,
	crumbs,
}: {
	title: string;
	description?: string | undefined;
	path: string;
	crumbs: DocsCrumb[];
}) {
	const url = absolute(path);
	const organization = {
		"@type": "Organization",
		name: "Zuse",
		url: PRODUCT_CANONICAL_URL,
	};
	return {
		"@context": "https://schema.org",
		"@graph": [
			{
				"@type": "TechArticle",
				"@id": `${url}#article`,
				headline: title,
				...(description ? { description } : {}),
				url,
				mainEntityOfPage: url,
				image: absolute(DOCS_OG_IMAGE.url),
				inLanguage: "en",
				author: organization,
				publisher: {
					...organization,
					logo: {
						"@type": "ImageObject",
						url: `${PRODUCT_CANONICAL_URL}/app-icon.png`,
					},
				},
				isPartOf: {
					"@type": "WebSite",
					name: DOCS_SITE_NAME,
					url: SITE_URL,
				},
			},
			{
				"@type": "BreadcrumbList",
				itemListElement: crumbs.map((crumb, index) => ({
					"@type": "ListItem",
					position: index + 1,
					name: crumb.name,
					item: absolute(crumb.path),
				})),
			},
		],
	};
}

export function DocsStructuredData(
	props: Parameters<typeof createDocsStructuredData>[0],
) {
	return (
		<script
			type="application/ld+json"
			// biome-ignore lint/security/noDangerouslySetInnerHtml: Trusted page metadata serialized as JSON with opening tags escaped.
			dangerouslySetInnerHTML={{
				__html: JSON.stringify(createDocsStructuredData(props)).replaceAll(
					"<",
					"\\u003c",
				),
			}}
		/>
	);
}
