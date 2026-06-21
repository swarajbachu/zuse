import { Container } from "@/components/container";
import { BlogCard } from "@/components/resources/blog-card";
import { blog } from "@/lib/source";

export const SuggestedBlogs = () => {
  const posts = blog
    .getPages()
    .toSorted((a, b) => b.data.date.getTime() - a.data.date.getTime()).slice(0, 3);

  return (
    <section className="w-full">
      <Container className="grid grid-cols-1 gap-6 py-30 md:grid-cols-2 lg:grid-cols-3">
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
      </Container>
    </section>
  );
};
