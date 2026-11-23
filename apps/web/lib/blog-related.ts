export interface RelatablePost {
	url: string;
	data: { category: string; date: Date; related?: string[] };
}

export const RELATED_POST_LIMIT = 3;

/**
 * Posts to feature under "Keep reading". Curated `related` slugs from the post's
 * frontmatter come first, in order; any remaining slots fall back to the most
 * recent posts in the same category so older articles never end up orphaned.
 */
export function getRelatedPosts<T extends RelatablePost>(
	currentUrl: string,
	pages: T[],
	limit = RELATED_POST_LIMIT,
): T[] {
	const current = pages.find((page) => page.url === currentUrl);
	const others = pages.filter((page) => page.url !== currentUrl);
	const curated = (current?.data.related ?? []).flatMap((slug) => {
		const match = others.find((page) => page.url === `/blog/${slug}`);
		return match ? [match] : [];
	});
	const fallback = others
		.filter((page) => !curated.includes(page))
		.toSorted((a, b) => {
			const relevance =
				Number(b.data.category === current?.data.category) -
				Number(a.data.category === current?.data.category);
			return relevance || b.data.date.getTime() - a.data.date.getTime();
		});
	return [...curated, ...fallback].slice(0, limit);
}
