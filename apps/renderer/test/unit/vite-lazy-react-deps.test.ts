/// <reference types="node" />

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const rendererFile = (path: string): string =>
	readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");

describe("renderer dependency optimization", () => {
	it("crawls every lazy renderer module before committing the optimizer graph", () => {
		const viteConfig = rendererFile("vite.config.ts");

		expect(viteConfig).toContain(
			'entries: ["index.html", "notch.html", "src/**/*.{ts,tsx}"]',
		);
		expect(viteConfig).toContain("holdUntilCrawlEnd: true");
		expect(viteConfig).not.toContain('"codemirror"');
	});

	it("keeps the lazy chat list in the initial React dependency graph", () => {
		const chatView = rendererFile("src/components/chat-view.tsx");
		const viteConfig = rendererFile("vite.config.ts");

		expect(chatView).toContain('from "@legendapp/list/react"');
		expect(viteConfig).toContain('"@legendapp/list/react"');
		expect(viteConfig).toContain('"react-dom"');
		expect(viteConfig).toContain('dedupe: ["react", "react-dom"]');
	});
});
