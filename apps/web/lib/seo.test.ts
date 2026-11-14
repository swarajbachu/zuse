import { describe, expect, it } from "vitest";
import robots from "../app/robots";
import { getSEO, resolveSiteUrl, siteConfig } from "./seo";

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
			absoluteTitle: "Open Source Cloud Agents for Coding | Zuse",
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
