import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { defineConfig } from "tsdown";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..", "..");
const desktopOutDir =
	process.env.ZUSE_DESKTOP_OUT_DIR?.trim() || "dist-electron";

// tsdown evaluates this config with its own loader (not the bun runtime), so
// bun's automatic `.env` loading doesn't reach it. Read .env files ourselves
// so both dev (`tsdown --watch`) and packaged builds inline the public WorkOS
// client id. A real shell/CI env var always wins.
const resolveClientId = (
	name: "WORKOS_CLIENT_ID" | "LINEAR_CLIENT_ID",
): string => {
	if (process.env[name]) return process.env[name];
	const envPaths = [
		resolve(process.cwd(), ".env"),
		resolve(__dirname, ".env"),
		resolve(repoRoot, ".env"),
	];
	for (const envPath of envPaths) {
		if (!existsSync(envPath)) continue;
		for (const line of readFileSync(envPath, "utf8").split("\n")) {
			const match = line.match(new RegExp(`^\\s*${name}\\s*=\\s*(.*?)\\s*$`));
			if (match?.[1] !== undefined) {
				return match[1].replace(/^["']|["']$/g, "");
			}
		}
	}
	return "";
};

const WORKOS_CLIENT_ID = resolveClientId("WORKOS_CLIENT_ID");
const LINEAR_CLIENT_ID = resolveClientId("LINEAR_CLIENT_ID");

const shared = {
	format: "cjs" as const,
	outDir: desktopOutDir,
	sourcemap: true,
	outExtensions: () => ({ js: ".cjs" }),
	// Inline the public WorkOS client id at build time so the bundled server
	// (apps/server is alwaysBundle'd below) reads a concrete value — the
	// packaged Electron process has no shell env. Empty when unset; AuthService
	// then surfaces a clear "not configured" error and auth stays optional.
	// Dev: `export WORKOS_CLIENT_ID=client_… ` before `bun run dev`.
	define: {
		"process.env.WORKOS_CLIENT_ID": JSON.stringify(WORKOS_CLIENT_ID),
		"process.env.LINEAR_CLIENT_ID": JSON.stringify(LINEAR_CLIENT_ID),
	},
	// Workspace packages ship as raw .ts source — bundle them in instead of
	// letting Node try to require() the .ts file at runtime.
	// `fix-path` is ESM-only ("type": "module"). Bundle it inline so the CJS
	// Electron main process can call it without crossing a require/ESM boundary.
	deps: {
		alwaysBundle: [
			"@zuse/contracts",
			"@zuse/agents",
			"@zuse/server",
			"@zuse/sqlite",
			"@zuse/index",
			"@zuse/ssh",
			"fix-path",
		],
		// Native modules whose loader uses `__dirname` / `module.parent.filename`
		// to locate a `.node` file at runtime — bundling their JS relocates those
		// anchors and the lookup fails. Keep them external so each is require()'d
		// from node_modules at runtime.
		neverBundle: [
			"electron",
			"node-pty",
			"bindings",
			"keytar",
			"electron-updater",
			"tree-sitter",
			"tree-sitter-typescript",
			"tree-sitter-javascript",
			"tree-sitter-json",
		],
	},
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
				"../../packages/agents/src/drivers/acp/browser-mcp-child.ts",
		},
		deps: {
			alwaysBundle: [
				"@zuse/contracts",
				"@zuse/agents",
				"@modelcontextprotocol/sdk",
			],
		},
	},
	{
		...shared,
		// The zuse-orchestration MCP child that provider-neutral sessions spawn
		// via bun/node to reach the session-bound parent bridge.
		entry: {
			"orchestration-mcp-child":
				"../../packages/agents/src/drivers/acp/orchestration-mcp-child.ts",
		},
		deps: {
			alwaysBundle: [
				"@zuse/contracts",
				"@zuse/agents",
				"@modelcontextprotocol/sdk",
			],
		},
	},
	{
		...shared,
		entry: {
			"linear-mcp-child":
				"../../packages/agents/src/drivers/acp/linear-mcp-child.ts",
		},
		deps: {
			alwaysBundle: [
				"@zuse/contracts",
				"@zuse/agents",
				"@modelcontextprotocol/sdk",
			],
		},
	},
]);
