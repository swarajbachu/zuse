/** Renders one JSON-LD block with opening tags escaped so the payload cannot close the script. */
export function JsonLd({ data }: { data: unknown }) {
	return (
		<script
			type="application/ld+json"
			// biome-ignore lint/security/noDangerouslySetInnerHtml: Trusted structured data serialized as JSON with opening tags escaped.
			dangerouslySetInnerHTML={{
				__html: JSON.stringify(data).replaceAll("<", "\\u003c"),
			}}
		/>
	);
}
