import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, searchForWorkspaceRoot } from "vite-plus";

import { gitRevisionRecovery } from "./vite-git-recovery.ts";
import { rendererProxy } from "./vite-proxy.ts";

const port = Number(process.env.PORT ?? 5733);
const host = process.env.HOST?.trim() || "localhost";
const rpcPort = Number(process.env.ZUSE_DESKTOP_WS_PORT ?? 8788);
const rpcTarget = `http://127.0.0.1:${rpcPort}`;
const sourceMaps = process.env.ZUSE_SOURCEMAPS === "1" ? "hidden" : false;
const hostedBuild = process.env.VITE_ZUSE_HOSTED === "1";

// In Memoize worktrees, the renderer's node_modules links out to a Bun
// central store at a sibling path (e.g. `~/Developer/<main checkout>/
// node_modules/.bun/...`), which sits OUTSIDE the workspace root. Vite's
// default `fs.allow` doesn't see it and refuses to serve font files. We
// resolve a known font package at config-load time and walk up to the
// store root so every hoisted dep gets allowed too.
const require = createRequire(import.meta.url);
const iconRuntime = require("../../scripts/icon-runtime.cjs") as {
	getPaidIconAliases: () => Record<string, string>;
	resolveIconMode: () => "free" | "paid";
};
const iconAliases =
	iconRuntime.resolveIconMode() === "paid"
		? iconRuntime.getPaidIconAliases()
		: {};
const desktopPackage = require("../desktop/package.json") as {
	version: string;
};
const effectSchemaPath = require.resolve("effect/Schema");
const fastCheckProductionStub = fileURLToPath(
	new URL("./src/lib/fast-check-production-stub.ts", import.meta.url),
);
const fontPkgPath = require.resolve("@fontsource-variable/geist/package.json");
// .../node_modules/.bun/@fontsource-variable+inter@X.Y.Z/node_modules/@fontsource-variable/inter/package.json
//                  ^^^^ walk up 5 dirs to reach `node_modules/.bun/`
const bunStoreRoot = dirname(dirname(dirname(dirname(dirname(fontPkgPath)))));

export default defineConfig({
	// Catalogs are consumed as dictionaries, never as named JSON exports.
	json: { stringify: true, namedExports: false },
	envDir: resolve(__dirname, "../.."),
	define: {
		"import.meta.env.VITE_APP_VERSION": JSON.stringify(desktopPackage.version),
	},
	cacheDir: process.env.ZUSE_VITE_CACHE_DIR?.trim() || undefined,
	experimental: {
		bundledDev: process.env.ZUSE_BUNDLED_DEV === "1",
	},
	// Hosted routes need root-relative assets, while packaged Electron builds
	// need relative assets so they continue to load through file://.
	base: hostedBuild ? "/" : "./",
	plugins: [
		gitRevisionRecovery(),
		{
			name: "omit-renderer-schema-test-data",
			apply: "build",
			enforce: "pre",
			resolveId(source, importer) {
				if (
					source === "./testing/FastCheck.js" &&
					importer?.split("?", 1)[0] === effectSchemaPath
				) {
					return fastCheckProductionStub;
				}
			},
		},
		react({
			babel: { plugins: [["babel-plugin-react-compiler", {}]] },
		}),
		tailwindcss(),
	],
	resolve: {
		alias: {
			...iconAliases,
			"~": fileURLToPath(new URL("./src", import.meta.url)),
		},
		// One React instance across workspace packages and @base-ui entry
		// points. A second copy makes `useEffect` read a null dispatcher.
		dedupe: ["react", "react-dom"],
	},
	optimizeDeps: {
		// Freeze the dependency graph before mounting React. Source crawling alone
		// misses delayed imports: re-optimizing them can invalidate an in-flight
		// bootstrap import and give a retried screen a different React dispatcher.
		// Keep browser dependencies explicit, including lazy/shared UI entrypoints.
		noDiscovery: true,
		holdUntilCrawlEnd: true,
		include: [
			"react",
			"react-dom",
			"react-dom/client",
			"react-i18next",
			// Optimizer recovery can request this ESM parser directly. Include its
			// CommonJS leaf so Chromium always receives Vite's default-export interop.
			"html-parse-stringify",
			"void-elements",
			"i18next",
			"react/jsx-runtime",
			"react/jsx-dev-runtime",
			"@base-ui/react/**",
			"@codemirror/commands",
			"@codemirror/state",
			"@codemirror/view",
			"@effect/atom-react",
			"@formkit/auto-animate",
			"@hugeicons/react",
			"@legendapp/list/react",
			"@noble/hashes/sha2",
			"@noble/hashes/utils",
			"effect",
			"effect/unstable/reactivity",
			"effect/unstable/rpc",
			"effect/unstable/rpc/RpcClientError",
			"effect/unstable/rpc/RpcMessage",
			"effect/unstable/socket",
			"@pierre/diffs",
			"@pierre/diffs/edit",
			"@pierre/diffs/react",
			"@pierre/trees",
			"@pierre/trees/react",
			"@zuse/icons/bulk-rounded",
			"@zuse/icons/solid-rounded",
			"@zuse/icons/stroke-rounded",
			"class-variance-authority",
			"clsx",
			"d3-scale",
			"d3-shape",
			"diff",
			"fflate",
			"fuzzysort",
			"gradient-shimmer",
			"lucide-react",
			"mermaid",
			"motion/react",
			"posthog-js/dist/module.slim",
			"qrcode.react",
			"react-markdown",
			"react-resizable-panels",
			"rehype-raw",
			"rehype-sanitize",
			"remark-gfm",
			"shiki",
			"tailwind-merge",
			"thinking-orbs",
		],
	},
	server: {
		host,
		port,
		strictPort: true,
		proxy: rendererProxy(hostedBuild, rpcTarget),
		fs: {
			allow: [searchForWorkspaceRoot(process.cwd()), bunStoreRoot],
		},
	},
	worker: {
		format: "es",
	},
	build: {
		outDir: "dist",
		emptyOutDir: true,
		manifest: true,
		sourcemap: sourceMaps,
		rollupOptions: {
			input: {
				main: resolve(__dirname, "index.html"),
				notch: resolve(__dirname, "notch.html"),
			},
		},
	},
	test: {
		setupFiles: ["./test/setup.ts"],
	},
});
