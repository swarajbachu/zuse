import type { AgentRow } from "@/lib/cloud-agents";
import { CHECKED_ON } from "@/lib/cloud-agents";
import { siteConfig } from "@/lib/seo";

/** ItemList + Dataset JSON-LD for the cloud coding agents directory. */
export function AgentsStructuredData({
	rows,
	path,
	title,
	description,
}: {
	rows: AgentRow[];
	path: string;
	title: string;
	description: string;
}) {
	const url = new URL(path, siteConfig.url).toString();
	const data = {
		"@context": "https://schema.org",
		"@graph": [
			{
				"@type": "Dataset",
				"@id": `${url}#dataset`,
				name: title,
				description,
				url,
				dateModified: CHECKED_ON,
				creator: {
					"@type": "Organization",
					name: siteConfig.name,
					url: siteConfig.url,
				},
				isAccessibleForFree: true,
				variableMeasured: [
					"Agents supported",
					"Hosted cloud agents",
					"Remote or self-hosted agents",
					"Parallel agents",
					"Bring your own subscription or key",
					"MCP",
					"Plugins",
					"Open source license",
					"Platforms",
					"Price",
					"Reputation score",
				],
			},
			{
				"@type": "ItemList",
				"@id": `${url}#list`,
				name: title,
				numberOfItems: rows.length,
				itemListElement: rows.map((row, i) => ({
					"@type": "ListItem",
					position: i + 1,
					name: row.name,
					url: row.url,
				})),
			},
		],
	};
	return (
		<script
			type="application/ld+json"
			// biome-ignore lint/security/noDangerouslySetInnerHtml: static JSON-LD
			dangerouslySetInnerHTML={{
				__html: JSON.stringify(data).replace(/</g, "\\u003c"),
			}}
		/>
	);
}
