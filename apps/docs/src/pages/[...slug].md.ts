import type { APIRoute } from "astro";
import { source } from "../lib/source";

type SourcePage = (ReturnType<typeof source.getPages>)[number];

export function getStaticPaths() {
	return source.getPages().map((page) => ({
		params: { slug: page.slugs.length > 0 ? page.slugs.join("/") : undefined },
		props: { page },
	}));
}

export const GET: APIRoute = ({ props }) => {
	const page = props.page as SourcePage;
	const markdown = [
		`# ${page.data.title}`,
		"",
		page.data.description,
		"",
		page.data._raw.body,
		"",
		`Last verified: ${page.data.lastVerified}`,
		"",
	].join("\n");
	return new Response(markdown, {
		headers: { "content-type": "text/markdown; charset=utf-8" },
	});
};
