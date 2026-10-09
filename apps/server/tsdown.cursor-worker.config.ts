import { defineConfig } from "tsdown";

export default defineConfig({
	entry: { "cursor-sdk": "src/cursor-worker-sdk.ts" },
	format: "esm",
	platform: "node",
	target: "node22",
	outDir: "dist-cloud/cursor",
	outExtensions: () => ({ js: ".mjs" }),
	clean: true,
	dts: false,
	sourcemap: false,
	outputOptions: { codeSplitting: false },
	deps: { alwaysBundle: [/.*/u] },
});
