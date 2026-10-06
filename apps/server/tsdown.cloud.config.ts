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
	outputOptions: {
		codeSplitting: false,
	},
	deps: {
		alwaysBundle: [/.*/u],
		neverBundle: [
			"@cursor/sdk",
			"bindings",
			"node-pty",
			"tree-sitter",
			"tree-sitter-javascript",
			"tree-sitter-json",
			"tree-sitter-typescript",
		],
		onlyImport: [
			"@cursor/sdk",
			"bindings",
			"node-pty",
			"tree-sitter",
			"tree-sitter-javascript",
			"tree-sitter-json",
			"tree-sitter-typescript",
		],
	},
});
