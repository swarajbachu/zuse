import { defineConfig } from "tsdown";

const shared = {
	format: "esm",
	outDir: process.env.ZUSE_SERVER_OUT_DIR?.trim() || "dist",
	outExtensions: () => ({ js: ".mjs" }),
	sourcemap: true,
	deps: {
		alwaysBundle: [
			/.*/u,
			"@zuse/agents",
			"@zuse/agents/**",
			"@zuse/contracts",
			"@zuse/domain",
			"@zuse/domain/**",
			"@zuse/git",
			"@zuse/git/**",
			"@zuse/index",
			"@zuse/pokemon-data",
			"@zuse/server",
			"@zuse/sqlite",
			"@zuse/utils",
			"@zuse/utils/**",
		],
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
};

export default defineConfig([
	{
		...shared,
		entry: ["src/bin.ts"],
		clean: true,
		dts: false,
	},
	{
		...shared,
		entry: { index: "src/index.ts", runtime: "src/runtime.ts" },
		dts: false,
	},
]);
