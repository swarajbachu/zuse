import { createFromSource } from "fumadocs-core/search/server";
import { source } from "@/lib/source";

export const { GET } = createFromSource(source, {
	buildIndex(page) {
		const structuredData = page.data.structuredData;

		if (!structuredData) {
			throw new Error(`Missing structured data for ${page.url}`);
		}

		return {
			id: page.url,
			title: page.data.title,
			url: page.url,
			structuredData: {
				headings: structuredData.headings,
				contents: [],
			},
		};
	},
});
