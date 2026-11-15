import { afterAll, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/source", () => ({
	blog: {
		getPages: () => [
			{ url: "/blog/first-article", data: {} },
			{ url: "/blog/new-article", data: { updated: new Date("2026-09-24") } },
		],
	},
}));

import sitemap from "./sitemap";

// Runs before the static imports: `siteConfig.url` is read when `@/lib/seo` loads,
// so a preview NEXT_PUBLIC_SITE_URL in the shell would otherwise leak in.
const originalSiteUrl = vi.hoisted(() => {
	const value = process.env.NEXT_PUBLIC_SITE_URL;
	delete process.env.NEXT_PUBLIC_SITE_URL;
	return value;
});

afterAll(() => {
	if (originalSiteUrl === undefined) delete process.env.NEXT_PUBLIC_SITE_URL;
	else process.env.NEXT_PUBLIC_SITE_URL = originalSiteUrl;
});

describe("public sitemap", () => {
	it("discovers articles from the content collection and includes pricing and the agents directory", () => {
		const paths = sitemap().map((entry) => new URL(entry.url).pathname);
		expect(paths).toEqual(
			expect.arrayContaining([
				"/blog",
				"/pricing",
				"/cloud-coding-agents",
				"/demo/guided-review",
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

	it("lists every URL on the canonical www host", () => {
		for (const entry of sitemap()) {
			expect(entry.url.startsWith("https://www.zuse.sh")).toBe(true);
		}
	});
});
