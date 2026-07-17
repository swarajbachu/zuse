/**
 * A user MCP server after Zuse has resolved it for use: env vars expanded,
 * any keychain-held token already injected into `headers`/`env`. This is the
 * shape drivers consume (Claude spreads it into `Options.mcpServers`) and
 * the shape the status probe connects with. It never crosses the renderer
 * wire — headers/env may hold secrets.
 */
export interface ResolvedMcpServer {
	readonly name: string;
	readonly transport: "stdio" | "http" | "sse";
	/** stdio */
	readonly command?: string;
	readonly args?: ReadonlyArray<string>;
	readonly env?: Readonly<Record<string, string>>;
	/** http/sse */
	readonly url?: string;
	readonly headers?: Readonly<Record<string, string>>;
}
