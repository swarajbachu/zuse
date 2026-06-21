import { loader } from "fumadocs-core/source";
import { blogPosts } from "collections/server";
import { toFumadocsSource } from "fumadocs-mdx/runtime/server";

export const blog = loader({
  baseUrl: "/blog",
  source: toFumadocsSource(blogPosts, []),
});
