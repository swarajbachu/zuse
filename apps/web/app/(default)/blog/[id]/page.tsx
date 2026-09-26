import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { BlogCtaSection } from "@/components/blogs/blog-cta-section";
import { BlogHeader } from "@/components/blogs/blog-header";
import { Content } from "@/components/blogs/content";
import { SuggestedBlogs } from "@/components/blogs/suggested-blogs";
import { ArticleStructuredData } from "@/components/seo/article-structured-data";
import { getSEO } from "@/lib/seo";
import { blog } from "@/lib/source";

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

	const metadata = getSEO({
		title: page.data.title,
		description: page.data.description,
		path: page.url,
		image:
			!page.data.previewImage || page.data.previewImage.endsWith(".svg")
				? "/og.png"
				: page.data.previewImage,
	});
	return {
		...metadata,
		openGraph: {
			...metadata.openGraph,
			type: "article",
			publishedTime: page.data.date.toISOString(),
			modifiedTime: page.data.updated?.toISOString(),
			authors: [page.data.authorName],
		},
	};
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
		<main className="journal-article w-full">
			<ArticleStructuredData
				title={page.data.title}
				description={page.data.description}
				url={page.url}
				image={page.data.previewImage ?? "/og.png"}
				date={page.data.date}
				updated={page.data.updated}
				author={page.data.authorName}
			/>
			<BlogHeader page={page} />
			<Content page={page} />
			<BlogCtaSection />
			<SuggestedBlogs currentUrl={page.url} />
		</main>
	);
}
