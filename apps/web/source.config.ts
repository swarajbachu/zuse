import { defineCollections, defineConfig } from "fumadocs-mdx/config";
import { pageSchema } from "fumadocs-core/source/schema";
import { z } from "zod";

const blogMetadataSchema = pageSchema.extend({
  date: z.coerce.date(),
  timeToRead: z.string(),
  authorName: z.string(),
  authorRole: z.string(),
  authorAvatar: z.string(),
  previewImage: z.string(),
  labels: z.array(z.object({ name: z.string(), hex: z.string() })).optional(),
});

export type BlogMetadata = z.infer<typeof blogMetadataSchema>;

export const blogPosts = defineCollections({
  type: "doc",
  dir: "content/blog",
  schema: blogMetadataSchema,
});

export default defineConfig();
