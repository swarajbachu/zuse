import type { Page } from "fumadocs-core/source";
import { AnchorProvider } from "fumadocs-core/toc";
import type { DocCollectionEntry } from "fumadocs-mdx/runtime/server";
import { TocLink } from "@/components/blogs/toc-link";
import { getMDXComponents } from "@/mdx-components";
import type { BlogMetadata } from "@/source.config";

export const Content = ({
	page,
}: {
	page: Page<undefined, DocCollectionEntry<"blogPosts", BlogMetadata>>;
}) => {
	const Mdx = page.data.body;
	const tocItems = page.data.toc.map((item) => ({
		url: item.url,
		depth: item.depth,
		title:
			typeof item.title === "string"
				? item.title
				: item.url
						.replace(/^#/, "")
						.split("-")
						.join(" ")
						.replace(/^./, (letter) => letter.toUpperCase()),
	}));
	const links = tocItems.map((item) => (
		<TocLink key={item.url} url={item.url}>
			{item.title}
		</TocLink>
	));
	return (
		<AnchorProvider toc={tocItems} single>
			<section className="article-layout">
				<div className="min-w-0">
					{tocItems.length > 0 && (
						<details className="mb-8 border-y border-dotted border-border py-4 text-xs lg:hidden">
							<summary className="cursor-pointer font-mono text-primary">
								On this page
							</summary>
							<nav
								aria-label="Article contents"
								className="mt-4 flex flex-col gap-3"
							>
								{links}
							</nav>
						</details>
					)}
					<article className="prose article-body min-w-0 max-w-none">
						<Mdx components={getMDXComponents()} />
					</article>
				</div>
				{tocItems.length > 0 && (
					<aside className="article-sidebar hidden lg:block">
						<nav
							aria-label="Article contents"
							className="sticky top-24 flex max-h-[calc(100dvh-7rem)] flex-col gap-4 overflow-y-auto text-xs leading-5"
						>
							<p className="editorial-label mb-2">On this page</p>
							{links}
						</nav>
					</aside>
				)}
			</section>
		</AnchorProvider>
	);
};
