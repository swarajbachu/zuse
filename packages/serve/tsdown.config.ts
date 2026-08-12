import { defineConfig } from "tsdown";

export default defineConfig({
	entry: ["src/bin.ts", "src/cli.ts", "src/status.ts", "src/agent-cli.ts"],
	format: "esm",
	outDir: "dist",
	outExtensions: () => ({ js: ".mjs" }),
	sourcemap: true,
	dts: false,
	deps: {
		alwaysBundle: [
			/.*/u,
			"@zuse/client-runtime",
			"@zuse/client-runtime/**",
			"@zuse/contracts",
			"@zuse/contracts/**",
			"@zusehq/server",
			"@zusehq/server/**",
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
});
