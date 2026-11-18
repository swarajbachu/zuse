import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { getRelatedPosts, type RelatablePost } from "./blog-related";

const post = (
	slug: string,
	category: string,
	day: number,
	related?: string[],
): RelatablePost => ({
	url: `/blog/${slug}`,
	data: { category, date: new Date(2026, 0, day), related },
});

describe("getRelatedPosts", () => {
	const pages = [
		post("a", "Guide", 1, ["d", "missing", "b"]),
		post("b", "Guide", 2),
		post("c", "Note", 3),
		post("d", "Note", 4),
		post("e", "Guide", 5),
	];

	it("puts curated posts first, skips unknown slugs, then fills by category and recency", () => {
		expect(getRelatedPosts("/blog/a", pages).map((p) => p.url)).toEqual([
			"/blog/d",
			"/blog/b",
			"/blog/e",
		]);
	});

	it("never returns the current post and honours the limit", () => {
		const urls = getRelatedPosts("/blog/a", pages, 2).map((p) => p.url);
		expect(urls).toHaveLength(2);
		expect(urls).not.toContain("/blog/a");
	});

	it("falls back to the category and recency order without curated slugs", () => {
		expect(getRelatedPosts("/blog/b", pages).map((p) => p.url)).toEqual([
			"/blog/e",
			"/blog/a",
			"/blog/d",
		]);
	});
});

describe("blog frontmatter related slugs", () => {
	const dir = join(import.meta.dirname, "..", "content", "blog");
	const files = readdirSync(dir).filter((file) => file.endsWith(".mdx"));
	const slugs = new Set(files.map((file) => file.replace(/\.mdx$/, "")));
	const relatedOf = (file: string) => {
		const match = readFileSync(join(dir, file), "utf8").match(
			/^related: (\[.*\])$/m,
		);
		return match ? (JSON.parse(match[1]) as string[]) : [];
	};

	it("lists three existing, distinct posts other than itself for every post", () => {
		for (const file of files) {
			const slug = file.replace(/\.mdx$/, "");
			const related = relatedOf(file);
			expect(related, slug).toHaveLength(3);
			expect(new Set(related).size, slug).toBe(3);
			expect(related, slug).not.toContain(slug);
			for (const target of related)
				expect(slugs.has(target), target).toBe(true);
		}
	});

	it("gives every post at least two curated inbound links", () => {
		const inbound = new Map<string, number>();
		for (const file of files)
			for (const target of relatedOf(file))
				inbound.set(target, (inbound.get(target) ?? 0) + 1);
		for (const slug of slugs)
			expect(inbound.get(slug) ?? 0, slug).toBeGreaterThanOrEqual(2);
	});
});
