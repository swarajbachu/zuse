import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { defineConfig } from "tsdown";

// tsdown evaluates this config with its own loader (not the bun runtime), so
// bun's automatic `.env` loading doesn't reach it. Read apps/desktop/.env
// ourselves so both dev (`tsdown --watch`) and packaged builds inline the
// public WorkOS client id. A real shell/CI env var always wins.
const resolveWorkosClientId = (): string => {
  if (process.env.WORKOS_CLIENT_ID) return process.env.WORKOS_CLIENT_ID;
  const envPath = resolve(process.cwd(), ".env");
  if (!existsSync(envPath)) return "";
  for (const line of readFileSync(envPath, "utf8").split("\n")) {
    const match = line.match(/^\s*WORKOS_CLIENT_ID\s*=\s*(.*?)\s*$/);
    if (match?.[1] !== undefined) {
      return match[1].replace(/^["']|["']$/g, "");
    }
  }
  return "";
};

const WORKOS_CLIENT_ID = resolveWorkosClientId();

const shared = {
  format: "cjs" as const,
  outDir: "dist-electron",
  sourcemap: true,
  outExtensions: () => ({ js: ".cjs" }),
  // Inline the public WorkOS client id at build time so the bundled server
  // (apps/server is alwaysBundle'd below) reads a concrete value — the
  // packaged Electron process has no shell env. Empty when unset; AuthService
  // then surfaces a clear "not configured" error and auth stays optional.
  // Dev: `export WORKOS_CLIENT_ID=client_… ` before `bun run dev`.
  define: {
    "process.env.WORKOS_CLIENT_ID": JSON.stringify(WORKOS_CLIENT_ID),
  },
  // Workspace packages ship as raw .ts source — bundle them in instead of
  // letting Node try to require() the .ts file at runtime.
  // `fix-path` is ESM-only ("type": "module"). Electron 33 ships Node 20.x
  // where `require()` of an ESM module throws ERR_REQUIRE_ESM. Bundling it
  // inline transpiles it to CJS so the main bundle can call it directly.
  deps: {
    alwaysBundle: [
      "@zuse/wire",
      "@zuse/server",
      "@zuse/index",
      "@zuse/ssh",
      "fix-path",
    ],
  },
  // Native modules whose loader uses `__dirname` / `module.parent.filename`
  // to locate a `.node` file at runtime — bundling their JS relocates those
  // anchors and the lookup fails. Keep them external so each is require()'d
  // from node_modules at runtime. electron-updater is also kept external —
  // it pulls in a large CommonJS dep graph (lodash, lazy-val, builder-util)
  // that loads cleanly via Node's resolver but trips bundlers.
  external: [
    // `electron` MUST be external. At runtime in the main process,
    // `require("electron")` is intercepted by Electron itself and returns
    // app/BrowserWindow/etc. as native bindings. If the bundler instead
    // inlines the `electron` npm package's index.js, that ships
    // `getElectronPath()` (which reads node_modules/electron/path.txt to
    // locate the binary) — at runtime that throws "Electron failed to
    // install correctly, please delete node_modules/electron…".
    "electron",
    "node-pty",
    "better-sqlite3",
    "bindings",
    "keytar",
    "electron-updater",
    // Tree-sitter parsers. Each uses node-gyp-build, which resolves its
    // .node file relative to the calling package's __dirname. Bundling
    // them inline rebinds __dirname to dist-electron/ and the lookup
    // explodes with "No native build was found for runtime=electron".
    "tree-sitter",
    "tree-sitter-typescript",
    "tree-sitter-javascript",
    "tree-sitter-json",
  ],
};

export default defineConfig([
  {
    ...shared,
    entry: ["src/main.ts"],
    clean: true,
  },
  {
    ...shared,
    entry: ["src/preload.ts"],
  },
  {
    ...shared,
    // The zuse-browser MCP child that ACP providers (Grok) spawn via bun to
    // reach the in-app browser. It runs OUTSIDE Electron — and, packaged,
    // outside the asar — so it can't resolve node_modules at runtime: bundle
    // every dependency in (the runtime graph is just @modelcontextprotocol/sdk
    // plus node builtins; the @zuse imports are type-only). The bridge resolves
    // this artifact next to the main bundle (browser-mcp-bridge.ts).
    entry: {
      "browser-mcp-child":
        "../server/src/provider/drivers/acp/browser-mcp-child.ts",
    },
    deps: {
      alwaysBundle: ["@zuse/wire", "@zuse/server", "@modelcontextprotocol/sdk"],
    },
    external: [],
  },
  {
    ...shared,
    // The zuse-orchestration MCP child that provider-neutral sessions spawn
    // via bun/node to reach the session-bound parent bridge.
    entry: {
      "orchestration-mcp-child":
        "../server/src/provider/drivers/acp/orchestration-mcp-child.ts",
    },
    deps: {
      alwaysBundle: ["@zuse/wire", "@zuse/server", "@modelcontextprotocol/sdk"],
    },
    external: [],
  },
]);
