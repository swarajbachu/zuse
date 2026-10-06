import { AsyncLocalStorage } from "node:async_hooks";
import { readdirSync } from "node:fs";
import { vi } from "vitest";

// Next's server test helpers expect the same global installed by its runtime.
Object.defineProperty(globalThis, "AsyncLocalStorage", {
	value: AsyncLocalStorage,
	configurable: true,
	writable: true,
});

// Fumadocs' collections/server is provided by its Next.js build plugin.
// Route unit tests only need collection URLs, so use the real MDX filenames
// without requiring the Next compiler to execute article bodies in Vitest.
vi.mock("@/lib/source", () => ({
	blog: {
		getPages: () =>
			readdirSync(new URL("../content/blog/", import.meta.url))
				.filter((name) => name.endsWith(".mdx"))
				.map((name) => ({ url: `/blog/${name.slice(0, -4)}`, data: {} })),
	},
}));
