import { fileURLToPath } from "node:url";
import { configDefaults, defineConfig } from "vitest/config";

// Mirrors the `~/*` path alias from tsconfig.json so unit tests can import
// modules that use it (Metro resolves it via the same mapping in the app).
export default defineConfig({
	resolve: {
		alias: {
			"~": fileURLToPath(new URL("./src", import.meta.url)),
		},
	},
	test: {
		exclude: [
			...configDefaults.exclude,
			"modules/mobile-terminal/android/test/**",
		],
	},
});
