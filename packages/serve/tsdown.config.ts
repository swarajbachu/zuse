import { defineConfig } from "tsdown";

export default defineConfig({
	entry: ["src/bin.ts"],
	format: "esm",
	outDir: "dist",
	outExtensions: () => ({ js: ".mjs" }),
	sourcemap: true,
	dts: false,
	deps: {
		alwaysBundle: [/.*/u, "@zusehq/server", "@zusehq/server/**"],
		neverBundle: [
			"bindings",
			"keytar",
			"node-pty",
			"tree-sitter",
			"tree-sitter-javascript",
			"tree-sitter-json",
			"tree-sitter-typescript",
		],
		onlyImport: [
			"bindings",
			"keytar",
			"node-pty",
			"tree-sitter",
			"tree-sitter-javascript",
			"tree-sitter-json",
			"tree-sitter-typescript",
		],
	},
});
