import { codexAppServerLaunchArgs } from "@zuse/agents/drivers/codex-app-server-client";
import { describe, expect, it } from "vitest";

describe("Codex app-server launch configuration", () => {
	it("injects the app MCP server with process-scoped config overrides", () => {
		expect(
			codexAppServerLaunchArgs({
				transport: "http",
				url: "http://127.0.0.1:4123/mcp",
				bearerTokenEnvVar: "ZUSE_MCP_TOKEN",
			}),
		).toEqual([
			"app-server",
			"--listen",
			"stdio://",
			"-c",
			'mcp_servers.zuse.url="http://127.0.0.1:4123/mcp"',
			"-c",
			'mcp_servers.zuse.bearer_token_env_var="ZUSE_MCP_TOKEN"',
		]);
	});

	it("injects a process-scoped stdio compatibility transport", () => {
		expect(
			codexAppServerLaunchArgs({
				transport: "stdio",
				command: "/usr/local/bin/bun",
				args: ["/tmp/app-mcp-proxy-child.ts"],
				env: {
					ZUSE_APP_MCP_URL: "http://127.0.0.1:4123/mcp",
					ZUSE_APP_MCP_TOKEN: "secret",
				},
			}),
		).toContain('mcp_servers.zuse.command="/usr/local/bin/bun"');
		expect(
			codexAppServerLaunchArgs({
				transport: "stdio",
				command: "bun",
				args: ["proxy.ts"],
				env: { ZUSE_APP_MCP_TOKEN: "secret" },
			}),
		).toContain('mcp_servers.zuse.env.ZUSE_APP_MCP_TOKEN="secret"');
	});

	it("does not add MCP overrides when no app server is configured", () => {
		expect(codexAppServerLaunchArgs()).toEqual([
			"app-server",
			"--listen",
			"stdio://",
		]);
	});
});
