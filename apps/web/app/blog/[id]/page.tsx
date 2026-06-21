import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { blog } from "@/lib/source";
import { getSEO } from "@/lib/seo";
import { BlogCtaSection } from "@/components/blogs/blog-cta-section";
import { BlogHeader } from "@/components/blogs/blog-header";
import { SuggestedBlogs } from "@/components/blogs/suggested-blogs";
import { Content } from "@/components/blogs/content";

export const dynamicParams = false;

export function generateStaticParams(): { id: string }[] {
  return blog.getPages().map((page) => ({
    id: page.slugs[0],
  }));
}

export async function generateMetadata(props: {
  params: Promise<{ id: string }>;
}): Promise<Metadata> {
  const params = await props.params;
  const page = blog.getPage([params.id]);
  if (!page) notFound();

  return getSEO({
    title: page.data.title,
    description: page.data.description,
    path: page.url,
    image: page.data.previewImage,
  });
}

export default async function BlogPostPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const page = blog.getPage([id]);

  if (!page) notFound();

  return (
    <section className="w-full">
      <BlogHeader page={page} />
      <BlogCtaSection />
      <Content page={page} />
      <SuggestedBlogs />
    </section>
  );
}
