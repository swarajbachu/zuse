import { defineConfig } from "tsdown";

export default defineConfig({
	entry: ["src/bin.ts"],
	format: "esm",
	outDir: "dist",
	outExtensions: () => ({ js: ".mjs" }),
	sourcemap: true,
	dts: false,
	deps: {
		neverBundle: ["@zusehq/serve", "@zusehq/serve/**"],
	},
});
