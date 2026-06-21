import { blog } from "@/lib/source";
import { getSEO } from "@/lib/seo";
import { Container } from "@/components/container";
import { Header } from "@/components/header";
import { BlogCard } from "@/components/resources/blog-card";

export const metadata = getSEO({
  title: "Blog",
  description:
    "Release notes, changelog, and deep dives on memoize — the chat-first macOS workspace for AI coding agents.",
  path: "/blog",
});

export default function BlogIndexPage() {
  const posts = blog
    .getPages()
    .toSorted((a, b) => b.data.date.getTime() - a.data.date.getTime());

  return (
    <section className="w-full">
      <Container className="flex flex-col gap-10 pt-30 pb-20">
        <Header>Blog</Header>
        <div className="grid grid-cols-1 gap-8 md:grid-cols-2 lg:grid-cols-3">
          {posts.map((post) => (
            <BlogCard
              key={post.url}
              card={{
                title: post.data.title,
                description: post.data.description || "",
                time: post.data.timeToRead,
                image: post.data.previewImage,
                href: post.url,
              }}
            />
          ))}
        </div>
      </Container>
    </section>
  );
}
