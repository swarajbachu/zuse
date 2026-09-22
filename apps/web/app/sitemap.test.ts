import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/source", () => ({
	blog: {
		getPages: () => [
			{ url: "/blog/first-article" },
			{ url: "/blog/new-article" },
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
		expect(sitemap().every((entry) => entry.lastModified === undefined)).toBe(
			true,
		);
	});
});
