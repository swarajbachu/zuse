import Link from "next/link";
import { blog } from "@/lib/source";

export const SuggestedBlogs = ({ currentUrl }: { currentUrl: string }) => {
	const pages = blog.getPages();
	const current = pages.find((page) => page.url === currentUrl);
	const posts = pages
		.filter((page) => page.url !== currentUrl)
		.toSorted((a, b) => {
			const relevance =
				Number(b.data.category === current?.data.category) -
				Number(a.data.category === current?.data.category);
			return relevance || b.data.date.getTime() - a.data.date.getTime();
		})
		.slice(0, 3);

	return (
		<section aria-labelledby="related-heading" className="journal-related">
			<div className="mb-7 flex items-center justify-between gap-4">
				<h2 id="related-heading" className="text-2xl">
					Keep reading
				</h2>
				<Link
					href="/blog"
					className="text-xs text-muted-foreground hover:text-primary"
				>
					All stories <span aria-hidden="true">↗</span>
				</Link>
			</div>
			<div className="journal-related-grid">
				{posts.map((post) => (
					<Link
						key={post.url}
						href={post.url}
						className="journal-related-link group"
					>
						<p className="editorial-label">{post.data.category}</p>
						<h3 className="mt-3 text-2xl group-hover:text-primary">
							{post.data.title}
						</h3>
						<p className="mt-4 font-mono text-[11px] text-muted-foreground">
							{post.data.timeToRead}
						</p>
					</Link>
				))}
			</div>
		</section>
	);
};
