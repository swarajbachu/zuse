import { pageSchema } from "fumadocs-core/source/schema";
import { defineConfig, defineDocs } from "fumadocs-mdx/config";
import { z } from "zod";

const documentationSchema = pageSchema.extend({
	description: z.string(),
	section: z.string(),
	order: z.number().int().nonnegative(),
	platforms: z.array(z.string()).default([]),
	providers: z.array(z.string()).default([]),
	prerequisites: z.array(z.string()).default([]),
	related: z.array(z.string()).default([]),
	next: z.string().optional(),
	lastVerified: z.string(),
});

export const docs = defineDocs({
	dir: "content/docs",
	docs: {
		schema: documentationSchema,
		postprocess: {
			includeProcessedMarkdown: true,
			extractLinkReferences: true,
		},
	},
});

export default defineConfig();
