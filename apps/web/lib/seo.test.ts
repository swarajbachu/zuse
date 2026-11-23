import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import robots from "../app/robots";
import { getSEO, resolveSiteUrl, siteConfig } from "./seo";

// Runs before the static imports: `siteConfig.url` is read when `./seo` loads,
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

describe("resolveSiteUrl", () => {
	it("defaults and normalizes the apex host to www", () => {
		expect(resolveSiteUrl()).toBe("https://www.zuse.sh");
		expect(resolveSiteUrl("https://zuse.sh")).toBe("https://www.zuse.sh");
		expect(resolveSiteUrl("http://zuse.sh/")).toBe("https://www.zuse.sh");
		expect(resolveSiteUrl("https://zuse.sh/blog")).toBe("https://www.zuse.sh");
	});

	it("leaves non-apex hosts unchanged so preview URLs still work", () => {
		expect(resolveSiteUrl("https://web-git-abc.vercel.app")).toBe(
			"https://web-git-abc.vercel.app",
		);
	});

	it("falls back when the value is not a URL", () => {
		expect(resolveSiteUrl("not a url")).toBe("https://www.zuse.sh");
	});
});

describe("site metadata", () => {
	it("uses the www origin for the live site", () => {
		expect(siteConfig.url).toBe("https://www.zuse.sh");
	});

	it("emits a per-page canonical and og:url on the www host", () => {
		const home = getSEO({
			absoluteTitle: "Zuse: Open Source Cloud Agents for Coding",
			path: "/",
		});
		expect(home.alternates?.canonical).toBe("https://www.zuse.sh/");
		expect(home.openGraph?.url).toBe("https://www.zuse.sh/");

		const post = getSEO({
			title: "Open source cloud agents: a practical guide for coding",
			path: "/blog/open-source-cloud-agents",
		});
		expect(post.alternates?.canonical).toBe(
			"https://www.zuse.sh/blog/open-source-cloud-agents",
		);
		expect(post.title).toBe(
			"Open source cloud agents: a practical guide for coding | Zuse",
		);
	});

	it("points robots.txt at the canonical host and sitemap", () => {
		const manifest = robots();
		expect(manifest.host).toBe("https://www.zuse.sh");
		expect(manifest.sitemap).toBe("https://www.zuse.sh/sitemap.xml");
	});
});

describe("title lengths", () => {
	const webRoot = join(import.meta.dirname, "..");
	const titleLimit = 60;

	it("leads the English homepage title with the brand and keeps it under 60 characters", () => {
		const catalog = JSON.parse(
			readFileSync(
				join(webRoot, "../../packages/i18n/locales/en/website/landing.json"),
				"utf8",
			),
		) as Record<string, string>;
		expect(catalog.meta_title.startsWith("Zuse")).toBe(true);
		expect(catalog.meta_title.length).toBeLessThanOrEqual(titleLimit);
	});

	it.each([
		"cloud-agent-recovery-journal",
		"openhands-vs-zuse",
	])("keeps the %s title and site suffix within 60 characters", (slug) => {
		const source = readFileSync(
			join(webRoot, "content/blog", `${slug}.mdx`),
			"utf8",
		);
		const title = source.match(/^title: "(.*)"$/m)?.[1] ?? "";
		const full = getSEO({ title }).title as string;
		expect(full.length).toBeLessThanOrEqual(titleLimit);
	});
});
