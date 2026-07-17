import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, searchForWorkspaceRoot } from "vite";

const port = Number(process.env.PORT ?? 5733);
const host = process.env.HOST?.trim() || "localhost";

// In Memoize worktrees, the renderer's node_modules links out to a Bun
// central store at a sibling path (e.g. `~/Developer/<main checkout>/
// node_modules/.bun/...`), which sits OUTSIDE the workspace root. Vite's
// default `fs.allow` doesn't see it and refuses to serve font files. We
// resolve a known font package at config-load time and walk up to the
// store root so every hoisted dep gets allowed too.
const require = createRequire(import.meta.url);
const fontPkgPath = require.resolve("@fontsource-variable/inter/package.json");
// .../node_modules/.bun/@fontsource-variable+inter@X.Y.Z/node_modules/@fontsource-variable/inter/package.json
//                  ^^^^ walk up 5 dirs to reach `node_modules/.bun/`
const bunStoreRoot = dirname(dirname(dirname(dirname(dirname(fontPkgPath)))));

export default defineConfig({
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
  server: {
    host,
    port,
    strictPort: true,
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
    sourcemap: true,
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
