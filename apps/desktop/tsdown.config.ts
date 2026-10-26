import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";
import { defineConfig, type UserConfig } from "tsdown";
import deploymentProfiles from "../../packages/contracts/src/deployment-profiles.json" with {
	type: "json",
};

const desktopDirectory = fileURLToPath(new URL(".", import.meta.url));
const environmentFiles = [
	...new Set([
		resolve(process.cwd(), ".env"),
		resolve(desktopDirectory, ".env"),
		fileURLToPath(new URL("../../.env", import.meta.url)),
	]),
].map((file) => {
	try {
		return parseEnv(readFileSync(file, "utf8"));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
		throw error;
	}
});

function buildValue(key: string, fallback = ""): string {
	if (process.env[key]) return process.env[key];
	for (const values of environmentFiles) {
		if (values[key] !== undefined) return values[key];
	}
	return fallback;
}

const environment =
	process.env.NODE_ENV === "production" ? "production" : "development";
const profile =
	environment === "production"
		? deploymentProfiles.production
		: deploymentProfiles.staging;

const publicValues: Record<string, string> = {
	NODE_ENV: environment,
	WORKOS_CLIENT_ID:
		buildValue("WORKOS_CLIENT_ID") || profile.workosPublicClientId,
	ZUSE_API_URL: buildValue("ZUSE_API_URL") || profile.apiUrl,
	ZUSE_POSTHOG_KEY: buildValue("ZUSE_POSTHOG_KEY"),
	ZUSE_POSTHOG_HOST:
		buildValue("ZUSE_POSTHOG_HOST") || "https://us.i.posthog.com",
	ZUSE_POSTHOG_ENABLE_DEV: buildValue("ZUSE_POSTHOG_ENABLE_DEV"),
};
const definitions = Object.fromEntries(
	Object.entries(publicValues).map(([key, value]) => [
		`process.env.${key}`,
		JSON.stringify(value),
	]),
);

const desktopDependencies: UserConfig["deps"] = {
	alwaysBundle: [
		"@homebridge/ciao",
		"@zuse/contracts",
		/^@zuse\/i18n(?:\/|$)/,
		"i18next",
		"@zuse/client-runtime",
		"@zuse/agents",
		"@zusehq/server",
		"@zuse/sqlite",
		"@zuse/index",
		"@zuse/ssh",
		"fix-path",
	],

	neverBundle: [
		"playwright",
		"playwright-core",
		"electron",
		"node-pty",
		"bindings",
		"keytar",
		"electron-updater",
		"@cursor/sdk",
		"tree-sitter",
		"tree-sitter-typescript",
		"tree-sitter-javascript",
		"tree-sitter-json",
	],
};
const bridgeDependencies: UserConfig["deps"] = {
	alwaysBundle: [
		"@zuse/contracts",
		"@zuse/agents",
		"@modelcontextprotocol/sdk",
	],
};

const targets = [
	{ name: "main", source: "src/main.ts", bridge: false },
	{ name: "engine-main", source: "src/engine-main.ts", bridge: false },
	{
		name: "engine-supervisor",
		source: "src/engine-supervisor.ts",
		bridge: false,
	},
	{ name: "preload", source: "src/preload.ts", bridge: false },
	{
		name: "app-mcp-proxy-child",
		source: "../../packages/agents/src/drivers/acp/app-mcp-proxy-child.ts",
		bridge: true,
	},
	{
		name: "browser-mcp-child",
		source: "../../packages/agents/src/drivers/acp/browser-mcp-child.ts",
		bridge: true,
	},
	{
		name: "orchestration-mcp-child",
		source: "../../packages/agents/src/drivers/acp/orchestration-mcp-child.ts",
		bridge: true,
	},
	{
		name: "ssh-bridge-child",
		source: "src/ssh/ssh-bridge-child.ts",
		bridge: false,
	},
];

export default defineConfig(
	targets.map(
		(target): UserConfig => ({
			entry: { [target.name]: target.source },
			format: "cjs",
			// Keep external loads lazy, but resolve their CommonJS entrypoints.
			// The packaged Cursor SDK deliberately excludes its duplicate ESM tree.
			outputOptions: { dynamicImportInCjs: false },
			outDir: process.env.ZUSE_DESKTOP_OUT_DIR?.trim() || "dist-electron",
			outExtensions: () => ({ js: ".cjs" }),
			sourcemap: true,
			// Electron entrypoints are executables, not libraries. Avoid eight
			// parallel declaration generators during development/watch builds.
			dts: false,
			clean: target.name === "main",
			define: definitions,
			deps: target.bridge ? bridgeDependencies : desktopDependencies,
		}),
	),
);
