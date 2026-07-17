import { describe, expect, it } from "vitest";

import {
	expandEnvRefs,
	parseClaudeServers,
	parseCodexServers,
} from "../../src/mcp/native-config.ts";

const CWD = "/Users/dev/project";

/** Builds a `${NAME}` config env-ref without tripping noTemplateCurlyInString. */
const ref = (name: string): string => ["${", name, "}"].join("");

describe("parseClaudeServers", () => {
	it("reads user-scope servers of every transport", () => {
		const servers = parseClaudeServers(
			{
				mcpServers: {
					posthog: {
						command: "npx",
						args: [
							"-y",
							"mcp-remote@latest",
							"https://mcp.example.com/sse",
							"--header",
							`Authorization:${ref("AUTH_HEADER")}`,
						],
						env: { AUTH_HEADER: "Bearer abc" },
					},
					vidiq: { type: "http", url: "https://mcp.vidiq.com/mcp" },
					legacy: { type: "sse", url: "https://legacy.example.com/sse" },
				},
			},
			null,
			null,
		);
		expect(servers.map((s) => [s.name, s.transport, s.source])).toEqual([
			["posthog", "stdio", "claude-user"],
			["vidiq", "http", "claude-user"],
			["legacy", "sse", "claude-user"],
		]);
		const posthog = servers.find((s) => s.name === "posthog");
		expect(posthog?.command).toBe("npx");
		expect(posthog?.envVarNames).toEqual(["AUTH_HEADER"]);
		expect(posthog?.enabledInConfig).toBe(true);
	});

	it("collapses scopes with local > project > user precedence", () => {
		const servers = parseClaudeServers(
			{
				mcpServers: {
					shared: { type: "http", url: "https://user.example.com" },
					userOnly: { type: "http", url: "https://user-only.example.com" },
				},
				projects: {
					[CWD]: {
						mcpServers: {
							shared: { type: "http", url: "https://local.example.com" },
						},
					},
				},
			},
			{
				mcpServers: {
					shared: { type: "http", url: "https://project.example.com" },
					projectOnly: { command: "uvx", args: ["some-server"] },
				},
			},
			CWD,
		);
		const byName = new Map(servers.map((s) => [s.name, s]));
		expect(byName.get("shared")?.url).toBe("https://local.example.com");
		expect(byName.get("shared")?.source).toBe("claude-local");
		expect(byName.get("projectOnly")?.source).toBe("claude-project");
		expect(byName.get("userOnly")?.source).toBe("claude-user");
	});

	it("skips malformed entries without failing the rest", () => {
		const servers = parseClaudeServers(
			{
				mcpServers: {
					good: { type: "http", url: "https://ok.example.com" },
					noUrl: { type: "http" },
					noCommand: { type: "stdio" },
					"bad name!": { type: "http", url: "https://x.example.com" },
					notAnObject: 42,
				},
			},
			null,
			null,
		);
		expect(servers.map((s) => s.name)).toEqual(["good"]);
	});
});

describe("parseCodexServers", () => {
	const TOML = `
[mcp_servers.pencil]
command = "/Applications/Pencil.app/mcp-server"
args = ["--ws-port", "55509"]

[mcp_servers.node_repl]
command = "node_repl"
startup_timeout_sec = 120

[mcp_servers.node_repl.env]
NODE_PATH = "/opt/node"

[mcp_servers.polar]
url = "https://mcp.polar.sh/mcp"

[mcp_servers.disabled_one]
command = "whatever"
enabled = false

[mcp_servers.zuse]
url = "http://127.0.0.1:55302/mcp/zuse"
bearer_token_env_var = "ZUSE_MCP_TOKEN"
`;

	it("reads stdio and http servers with codex-specific fields", () => {
		const servers = parseCodexServers(TOML, ["zuse", "zuse-orchestration"]);
		const byName = new Map(servers.map((s) => [s.name, s]));
		expect(byName.get("pencil")?.transport).toBe("stdio");
		expect(byName.get("pencil")?.args).toEqual(["--ws-port", "55509"]);
		expect(byName.get("node_repl")?.env).toEqual({ NODE_PATH: "/opt/node" });
		expect(byName.get("node_repl")?.startupTimeoutMs).toBe(120_000);
		expect(byName.get("polar")?.transport).toBe("http");
		expect(byName.get("disabled_one")?.enabledInConfig).toBe(false);
	});

	it("excludes Zuse's own gateway entries", () => {
		const servers = parseCodexServers(TOML, ["zuse", "zuse-orchestration"]);
		expect(servers.find((s) => s.name === "zuse")).toBeUndefined();
	});

	it("returns [] for malformed toml", () => {
		expect(parseCodexServers("not = [valid", [])).toEqual([]);
	});
});

describe("expandEnvRefs", () => {
	it("prefers the entry env, falls back to process.env, keeps unknown refs", () => {
		process.env.MCP_TEST_FROM_PROCESS = "proc";
		try {
			expect(
				expandEnvRefs(
					[ref("LOCAL"), ref("MCP_TEST_FROM_PROCESS"), ref("MISSING_REF")].join(
						"/",
					),
					{ LOCAL: "local" },
				),
			).toBe(`local/proc/${ref("MISSING_REF")}`);
		} finally {
			delete process.env.MCP_TEST_FROM_PROCESS;
		}
	});
});
