import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/source", () => ({
	blog: {
		getPages: () => [
			{ url: "/blog/first-article", data: {} },
			{ url: "/blog/new-article", data: { updated: new Date("2026-09-24") } },
		],
	},
}));

import sitemap from "./sitemap";

describe("public sitemap", () => {
	it("discovers articles from the content collection and includes pricing", () => {
		const paths = sitemap().map((entry) => new URL(entry.url).pathname);
		expect(paths).toEqual(
			expect.arrayContaining([
				"/blog",
				"/pricing",
				"/blog/first-article",
				"/blog/new-article",
			]),
		);
		expect(new Set(paths).size).toBe(paths.length);
	});

	it("does not manufacture modification dates for published content", () => {
		const dated = sitemap().filter((entry) => entry.lastModified);
		expect(dated).toHaveLength(1);
		expect(dated[0].url).toContain("/blog/new-article");
		expect(dated[0].lastModified).toEqual(new Date("2026-09-24"));
	});
});
