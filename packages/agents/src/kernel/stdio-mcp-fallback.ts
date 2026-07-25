import { existsSync } from "node:fs";
import { basename, sep } from "node:path";
import { fileURLToPath } from "node:url";

export interface StdioMcpFallbackOptions {
	readonly command: string;
	readonly endpoint: string;
	readonly token: string;
}

export interface StdioMcpServerConfig {
	readonly name: "zuse";
	readonly command: string;
	readonly args: ReadonlyArray<string>;
	readonly env: ReadonlyArray<{
		readonly name: string;
		readonly value: string;
	}>;
}

const childPath = (): string => {
	const bundled = fileURLToPath(
		new URL("../drivers/acp/app-mcp-proxy-child.cjs", import.meta.url),
	);
	const unpacked = bundled.replace(
		`${sep}app.asar${sep}`,
		`${sep}app.asar.unpacked${sep}`,
	);
	if (existsSync(unpacked)) return unpacked;
	if (existsSync(bundled)) return bundled;
	return fileURLToPath(
		new URL("../drivers/acp/app-mcp-proxy-child.ts", import.meta.url),
	);
};

export const makeStdioMcpFallback = (
	options: StdioMcpFallbackOptions,
): {
	readonly ensure: () => Promise<ReadonlyArray<StdioMcpServerConfig>>;
	readonly close: () => Promise<void>;
} => {
	const config: StdioMcpServerConfig = {
		name: "zuse",
		command: basename(options.command).includes("bun")
			? options.command
			: process.execPath,
		args: [childPath()],
		env: [
			{ name: "ZUSE_APP_MCP_URL", value: options.endpoint },
			{ name: "ZUSE_APP_MCP_TOKEN", value: options.token },
		],
	};
	return {
		ensure: async () => [config],
		close: async () => undefined,
	};
};
