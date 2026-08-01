import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	CodexAppServerClient,
	type CodexAppServerRequestError,
	codexAppServerLaunchArgs,
} from "@zuse/agents/drivers/codex-app-server-client";
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

describe("Codex app-server request errors", () => {
	it("preserves structured JSON-RPC error details from the transport", async () => {
		const directory = mkdtempSync(join(tmpdir(), "zuse-app-server-error-"));
		const executable = join(directory, "fake-app-server.mjs");
		let client: CodexAppServerClient | null = null;
		try {
			writeFileSync(
				executable,
				`#!/usr/bin/env node
import readline from "node:readline";
const lines = readline.createInterface({ input: process.stdin });
lines.on("line", (line) => {
	const request = JSON.parse(line);
	const result = request.method === "initialize"
		? { userAgent: "test", codexHome: "", platformFamily: "", platformOs: "" }
		: undefined;
	const response = result === undefined
		? {
				id: request.id,
				error: {
					code: -32600,
					message: "no rollout found for thread id stale-thread",
					data: { retryable: false },
				},
			}
		: { id: request.id, result };
	process.stdout.write(JSON.stringify(response) + "\\n");
});
`,
				{ mode: 0o755 },
			);

			client = await CodexAppServerClient.start({
				codexPath: executable,
				startupTimeoutMs: 2_000,
				onNotification: () => {},
				onServerRequest: () => {},
			});
			await expect(client.request("model/list", {})).rejects.toMatchObject({
				name: "CodexAppServerRequestError",
				code: -32600,
				message: "no rollout found for thread id stale-thread",
				data: { retryable: false },
			} satisfies Partial<CodexAppServerRequestError>);
		} finally {
			client?.close();
			rmSync(directory, { recursive: true, force: true });
		}
	});
});
