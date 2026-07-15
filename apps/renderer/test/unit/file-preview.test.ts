import { describe, expect, it } from "vitest";

import {
	defaultFileViewForName,
	resolveMarkdownPreviewUrl,
} from "../../src/lib/file-preview.ts";

describe("file preview", () => {
	it("opens markdown files in preview by default", () => {
		expect(defaultFileViewForName("LULU-27.md")).toBe("preview");
		expect(defaultFileViewForName("notes.markdown")).toBe("preview");
		expect(defaultFileViewForName("index.ts")).toBe("edit");
		expect(defaultFileViewForName("index.html")).toBe("edit");
	});

	it("resolves relative markdown images from the markdown file directory", () => {
		expect(
			resolveMarkdownPreviewUrl(
				"assets/LULU-27/image.png",
				"src",
				"img",
				"file:///workspace/.context/linear/team/",
			),
		).toBe(
			"zuse://linear-context/workspace/.context/linear/team/assets/LULU-27/image.png",
		);
	});

	it("does not rewrite links, remote images, or paths outside the file directory", () => {
		const baseHref = "file:///workspace/docs/";
		expect(
			resolveMarkdownPreviewUrl("guide.md", "href", "a", baseHref),
		).toBeNull();
		expect(
			resolveMarkdownPreviewUrl(
				"https://example.com/a.png",
				"src",
				"img",
				baseHref,
			),
		).toBeNull();
		expect(
			resolveMarkdownPreviewUrl("image.png", "src", "img", baseHref),
		).toBeNull();
		expect(
			resolveMarkdownPreviewUrl("../secret.png", "src", "img", baseHref),
		).toBeNull();
	});
});
