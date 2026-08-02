import type { CollectionEntry } from "astro:content";
import { getCollection } from "astro:content";
import path from "node:path";
import { type StructuredData, structure } from "fumadocs-core/mdx-plugins";
import type { StaticSource } from "fumadocs-core/source";
import { loader } from "fumadocs-core/source";

export const source = loader({
	source: await createAstroSource(),
	baseUrl: "/",
});

export function getStructuredData(
	entry: CollectionEntry<"docs">,
): StructuredData {
	return structure(entry.body ?? "");
}

async function createAstroSource() {
	const output: StaticSource<{
		metaData: CollectionEntry<"meta">["data"];
		pageData: CollectionEntry<"docs">["data"] & {
			_raw: CollectionEntry<"docs">;
		};
	}> = { files: [] };

	for (const page of await getCollection("docs")) {
		const virtualPath = path.relative("content/docs", page.filePath ?? page.id);
		output.files.push({
			type: "page",
			path: virtualPath,
			data: { ...page.data, _raw: page },
		});
	}

	for (const meta of await getCollection("meta")) {
		const virtualPath = path.relative("content/docs", meta.filePath ?? meta.id);
		output.files.push({
			type: "meta",
			path: virtualPath,
			data: meta.data,
		});
	}

	return output;
}
