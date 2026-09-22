import type { Page } from "fumadocs-core/source";
import type { DocCollectionEntry } from "fumadocs-mdx/runtime/server";
import Image from "next/image";
import Link from "next/link";
import type { BlogMetadata } from "@/source.config";
export const BlogHeader = ({
	page,
}: {
	page: Page<undefined, DocCollectionEntry<"blogPosts", BlogMetadata>>;
}) => (
	<header className="journal-article-header px-5 pt-10 md:px-16 md:pt-14">
		<Link href="/blog" className="editorial-label hover:underline">
			Journal / {page.data.category}
		</Link>
		<div className="mt-8 max-w-4xl">
			<time
				className="editorial-label text-muted-foreground"
				dateTime={page.data.date.toISOString()}
			>
				{page.data.date.toLocaleDateString("en-US", {
					month: "long",
					day: "numeric",
					year: "numeric",
					timeZone: "UTC",
				})}
			</time>
			<h1 className="mt-6 text-[clamp(2.25rem,5vw,4.25rem)] text-balance">
				{page.data.title}
			</h1>
			<p className="mt-6 max-w-2xl text-base leading-relaxed text-muted-foreground">
				{page.data.description}
			</p>
			<p className="mt-6 font-mono text-xs text-muted-foreground">
				{page.data.authorName} / {page.data.timeToRead}
			</p>
		</div>
		{page.data.category !== "Note" && page.data.previewImage && (
			<Image
				src={page.data.previewImage}
				alt=""
				width={1200}
				height={630}
				priority
				sizes="(max-width: 767px) 100vw, 1024px"
				className="mt-8 aspect-[2.8] w-full rounded-lg object-cover"
			/>
		)}
	</header>
);
