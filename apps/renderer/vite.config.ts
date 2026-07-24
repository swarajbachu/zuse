import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, searchForWorkspaceRoot } from "vite-plus";

const port = Number(process.env.PORT ?? 5733);
const host = process.env.HOST?.trim() || "localhost";
const rpcPort = Number(process.env.ZUSE_DESKTOP_WS_PORT ?? 8788);
const rpcTarget = `http://127.0.0.1:${rpcPort}`;
const sourceMaps = process.env.ZUSE_SOURCEMAPS === "1" ? "hidden" : false;

// In Memoize worktrees, the renderer's node_modules links out to a Bun
// central store at a sibling path (e.g. `~/Developer/<main checkout>/
// node_modules/.bun/...`), which sits OUTSIDE the workspace root. Vite's
// default `fs.allow` doesn't see it and refuses to serve font files. We
// resolve a known font package at config-load time and walk up to the
// store root so every hoisted dep gets allowed too.
const require = createRequire(import.meta.url);
const desktopPackage = require("../desktop/package.json") as {
	version: string;
};
const fontPkgPath = require.resolve("@fontsource-variable/inter/package.json");
// .../node_modules/.bun/@fontsource-variable+inter@X.Y.Z/node_modules/@fontsource-variable/inter/package.json
//                  ^^^^ walk up 5 dirs to reach `node_modules/.bun/`
const bunStoreRoot = dirname(dirname(dirname(dirname(dirname(fontPkgPath)))));

export default defineConfig({
	define: {
		"import.meta.env.VITE_APP_VERSION": JSON.stringify(desktopPackage.version),
	},
	cacheDir: process.env.ZUSE_VITE_CACHE_DIR?.trim() || undefined,
	experimental: {
		bundledDev: process.env.ZUSE_BUNDLED_DEV === "1",
	},
	// Relative base so file:// loads work in the packaged Electron build.
	base: "./",
	plugins: [
		react({
			babel: { plugins: [["babel-plugin-react-compiler", {}]] },
		}),
		tailwindcss(),
	],
	resolve: {
		alias: {
			"~": fileURLToPath(new URL("./src", import.meta.url)),
		},
	},
	optimizeDeps: {
		include: [
			"react",
			"react-dom/client",
			"effect",
			"@pierre/diffs",
			"codemirror",
			"@xterm/xterm",
		],
	},
	server: {
		host,
		port,
		strictPort: true,
		proxy: {
			"/auth": { target: rpcTarget },
			"/assets/attachments": { target: rpcTarget },
			"/rpc": { target: rpcTarget, ws: true },
		},
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
