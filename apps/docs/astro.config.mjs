// @ts-check
import mdx from "@astrojs/mdx";
import react from "@astrojs/react";
import sitemap from "@astrojs/sitemap";
import tailwindcss from "@tailwindcss/vite";
import { unified } from "@astrojs/markdown-remark";
import { defineConfig } from "astro/config";
import {
	rehypeCode,
	remarkCodeTab,
	remarkHeading,
	remarkNpm,
	remarkStructure,
} from "fumadocs-core/mdx-plugins";

/** @type {any[]} */
const remarkPlugins = [
	remarkHeading,
	remarkCodeTab,
	remarkNpm,
	[remarkStructure, { exportAs: "structuredData" }],
];

export default defineConfig({
	site: "https://docs.zuse.sh",
	output: "static",
	markdown: {
		processor: unified({
			remarkPlugins,
			rehypePlugins: [rehypeCode],
		}),
	},
	integrations: [
		react(),
		mdx({ extendMarkdownConfig: true, syntaxHighlight: false }),
		sitemap(),
	],
	vite: {
		plugins: [tailwindcss()],
	},
});
