import { defineConfig } from "tsdown";

export default defineConfig({
	entry: { bin: "src/cloud-bin.ts" },
	format: "esm",
	platform: "node",
	target: "node22",
	outDir: "dist-cloud",
	outExtensions: () => ({ js: ".mjs" }),
	clean: true,
	dts: false,
	sourcemap: false,
	outputOptions: { codeSplitting: false },
	deps: { alwaysBundle: [/.*/u] },
});
