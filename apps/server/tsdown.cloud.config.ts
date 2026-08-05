import { defineConfig } from "tsdown";

export default defineConfig({
	entry: ["src/bin.ts"],
	format: "esm",
	platform: "node",
	target: "node22",
	outDir: "dist-cloud",
	outExtensions: () => ({ js: ".mjs" }),
	clean: true,
	dts: false,
	sourcemap: false,
	treeshake: true,
	deps: {
		alwaysBundle: [/.*/u],
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
