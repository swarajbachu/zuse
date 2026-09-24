import { pageSchema } from "fumadocs-core/source/schema";
import { defineCollections, defineConfig } from "fumadocs-mdx/config";
import { z } from "zod";

const blogMetadataSchema = pageSchema.extend({
	date: z.coerce.date(),
	updated: z.coerce.date().optional(),
	category: z.enum(["Guide", "Note", "News"]).default("Note"),
	timeToRead: z.string(),
	authorName: z.string(),
	authorRole: z.string(),
	authorAvatar: z.string(),
	previewImage: z.string().optional(),
	labels: z.array(z.object({ name: z.string(), hex: z.string() })).optional(),
});

export type BlogMetadata = z.infer<typeof blogMetadataSchema>;

export const blogPosts = defineCollections({
	type: "doc",
	dir: "content/blog",
	schema: blogMetadataSchema,
});

export default defineConfig();
