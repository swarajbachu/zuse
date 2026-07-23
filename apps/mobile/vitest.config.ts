import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Mirrors the `~/*` path alias from tsconfig.json so unit tests can import
// modules that use it (Metro resolves it via the same mapping in the app).
export default defineConfig({
	resolve: {
		alias: {
			"~": fileURLToPath(new URL("./src", import.meta.url)),
		},
	},
});
