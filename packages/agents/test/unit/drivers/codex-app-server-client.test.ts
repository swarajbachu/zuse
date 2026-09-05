import {
	existsSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	CodexAppServerClient,
	type CodexAppServerRequestError,
	codexAppServerLaunchArgs,
	getDefaultCodexExternalAuthTokens,
	setDefaultCodexExternalAuthProvider,
} from "@zuse/agents/drivers/codex-app-server-client";
import { CODEX_EXTERNAL_AUTH_TOOLCHAIN_VERSION } from "@zuse/contracts";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);

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

describe("Codex app-server external authentication", () => {
	it("shares brokered tokens with non-session Codex capabilities without disk auth", async () => {
		setDefaultCodexExternalAuthProvider({
			getTokens: async ({ reason }) => ({
				accessToken: `access-${reason}`,
				chatgptAccountId: "chatgpt-account",
				chatgptPlanType: "pro",
				expiresAt: Date.now() + 3_600_000,
			}),
		});
		try {
			await expect(
				getDefaultCodexExternalAuthTokens("proactive"),
			).resolves.toMatchObject({ accessToken: "access-proactive" });
		} finally {
			setDefaultCodexExternalAuthProvider(null);
		}
	});

	it("reports the exact auth-blocked session without falling back to native credentials", async () => {
		const directory = mkdtempSync(join(tmpdir(), "zuse-pinned-codex-blocked-"));
		try {
			const failures: Array<{ consumerId?: string; reason: string }> = [];
			await expect(
				CodexAppServerClient.start({
					codexPath: require.resolve("@openai/codex/bin/codex.js"),
					env: { ...process.env, CODEX_HOME: directory },
					startupTimeoutMs: 5_000,
					onNotification: () => {},
					onServerRequest: () => {},
					externalAuthConsumerId: "session-1",
					externalAuthProvider: {
						getTokens: async () =>
							Promise.reject(new Error("codex-auth-reconnect-required")),
						onDeliveryFailure: (failure) => failures.push(failure),
					},
				}),
			).rejects.toThrow("codex-auth-reconnect-required");
			expect(failures).toEqual([
				{
					consumerId: "session-1",
					reason: "codex-auth-reconnect-required",
				},
			]);
			expect(existsSync(join(directory, "auth.json"))).toBe(false);
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});

	it("contract-tests the pinned Codex binary without persisting auth", async () => {
		expect(
			(require("@openai/codex/package.json") as { version: string }).version,
		).toBe(CODEX_EXTERNAL_AUTH_TOOLCHAIN_VERSION);
		const directory = mkdtempSync(join(tmpdir(), "zuse-pinned-codex-auth-"));
		let client: CodexAppServerClient | null = null;
		try {
			const payload = Buffer.from(
				JSON.stringify({
					email: "contract@example.com",
					exp: Math.floor(Date.now() / 1_000) + 3_600,
				}),
			).toString("base64url");
			const accessToken = `e30.${payload}.signature`;
			client = await CodexAppServerClient.start({
				codexPath: require.resolve("@openai/codex/bin/codex.js"),
				env: { ...process.env, CODEX_HOME: directory },
				startupTimeoutMs: 5_000,
				onNotification: () => {},
				onServerRequest: () => {},
				externalAuthProvider: {
					getTokens: async () => ({
						accessToken,
						chatgptAccountId: "chatgpt-account",
						chatgptPlanType: "pro",
						expiresAt: Date.now() + 3_600_000,
					}),
				},
			});
			await expect(
				client.request("account/read", { refreshToken: false }),
			).resolves.toMatchObject({
				account: { type: "chatgpt" },
			});
			expect(existsSync(join(directory, "auth.json"))).toBe(false);
		} finally {
			client?.close();
			rmSync(directory, { recursive: true, force: true });
		}
	});

	it("installs account tokens in memory and handles Codex refresh callbacks", async () => {
		const directory = mkdtempSync(join(tmpdir(), "zuse-app-server-auth-"));
		const executable = join(directory, "fake-app-server.mjs");
		const capture = join(directory, "capture.json");
		let client: CodexAppServerClient | null = null;
		try {
			writeFileSync(
				executable,
				`#!/usr/bin/env node
import { writeFileSync } from "node:fs";
import readline from "node:readline";
const capture = process.env.CAPTURE_PATH;
const lines = readline.createInterface({ input: process.stdin });
let login;
lines.on("line", (line) => {
	const message = JSON.parse(line);
	if (message.method === "initialize") {
		process.stdout.write(JSON.stringify({ id: message.id, result: { userAgent: "test", codexHome: "", platformFamily: "", platformOs: "" } }) + "\\n");
		return;
	}
	if (message.method === "account/login/start") {
		login = message.params;
		process.stdout.write(JSON.stringify({ id: message.id, result: { type: "chatgptAuthTokens" } }) + "\\n");
		process.stdout.write(JSON.stringify({ id: 99, method: "account/chatgptAuthTokens/refresh", params: { reason: "unauthorized", previousAccountId: "chatgpt-account" } }) + "\\n");
		return;
	}
	if (message.id === 99 && message.method === undefined) {
		writeFileSync(capture, JSON.stringify({ login, refresh: message.result }));
	}
});
`,
				{ mode: 0o755 },
			);
			let calls = 0;
			setDefaultCodexExternalAuthProvider({
				getTokens: async ({ reason }) => {
					calls += 1;
					return {
						accessToken:
							reason === "unauthorized" ? "refreshed-access" : "initial-access",
						chatgptAccountId: "chatgpt-account",
						chatgptPlanType: "pro",
						expiresAt: Date.now() + 60_000,
					};
				},
			});
			client = await CodexAppServerClient.start({
				codexPath: executable,
				env: { ...process.env, CAPTURE_PATH: capture },
				startupTimeoutMs: 2_000,
				onNotification: () => {},
				onServerRequest: () => {},
			});
			for (let attempt = 0; attempt < 100 && !existsSync(capture); attempt += 1)
				await new Promise((resolve) => setTimeout(resolve, 10));
			const recorded = JSON.parse(readFileSync(capture, "utf8")) as {
				login: Record<string, unknown>;
				refresh: Record<string, unknown>;
			};
			expect(recorded.login).toEqual({
				type: "chatgptAuthTokens",
				accessToken: "initial-access",
				chatgptAccountId: "chatgpt-account",
				chatgptPlanType: "pro",
			});
			expect(recorded.refresh).toEqual({
				accessToken: "refreshed-access",
				chatgptAccountId: "chatgpt-account",
				chatgptPlanType: "pro",
			});
			expect(calls).toBe(2);
		} finally {
			client?.close();
			setDefaultCodexExternalAuthProvider(null);
			rmSync(directory, { recursive: true, force: true });
		}
	});
});

describe("Codex app-server process lifecycle", () => {
	it("reports one unexpected exit with a bounded stderr tail", async () => {
		const directory = mkdtempSync(join(tmpdir(), "zuse-app-server-exit-"));
		const executable = join(directory, "fake-app-server.mjs");
		const terminations: Array<Error> = [];
		let client: CodexAppServerClient | null = null;
		try {
			writeFileSync(
				executable,
				`#!/usr/bin/env node
import readline from "node:readline";
const lines = readline.createInterface({ input: process.stdin });
lines.on("line", (line) => {
	const request = JSON.parse(line);
	if (request.method === "initialize") {
		process.stdout.write(JSON.stringify({
			id: request.id,
			result: { userAgent: "test", codexHome: "", platformFamily: "", platformOs: "" },
		}) + "\\n");
		return;
	}
	process.stderr.write("discarded-prefix:" + "x".repeat(5000) + ":fatal-tail-marker\\n", () => {
		process.exit(17);
	});
});
`,
				{ mode: 0o755 },
			);

			client = await CodexAppServerClient.start({
				codexPath: executable,
				startupTimeoutMs: 2_000,
				onStderr: () => {},
				onNotification: () => {},
				onServerRequest: () => {},
				onUnexpectedTermination: (error) => terminations.push(error),
			});
			await expect(client.request("model/list", {})).rejects.toThrow(
				/Codex app-server exited with code 17[\s\S]*fatal-tail-marker/,
			);
			expect(terminations).toHaveLength(1);
			expect(terminations[0]?.message).not.toContain("discarded-prefix");
			expect(
				Buffer.byteLength(terminations[0]?.message ?? "", "utf8"),
			).toBeLessThan(4_300);
		} finally {
			client?.close();
			rmSync(directory, { recursive: true, force: true });
		}
	});

	it("keeps explicit close silent", async () => {
		const directory = mkdtempSync(join(tmpdir(), "zuse-app-server-close-"));
		const executable = join(directory, "fake-app-server.mjs");
		const terminations: Array<Error> = [];
		let client: CodexAppServerClient | null = null;
		try {
			writeFileSync(
				executable,
				`#!/usr/bin/env node
import readline from "node:readline";
const lines = readline.createInterface({ input: process.stdin });
lines.on("line", (line) => {
	const request = JSON.parse(line);
	if (request.method !== "initialize") return;
	process.stdout.write(JSON.stringify({
		id: request.id,
		result: { userAgent: "test", codexHome: "", platformFamily: "", platformOs: "" },
	}) + "\\n");
});
`,
				{ mode: 0o755 },
			);

			client = await CodexAppServerClient.start({
				codexPath: executable,
				startupTimeoutMs: 2_000,
				onNotification: () => {},
				onServerRequest: () => {},
				onUnexpectedTermination: (error) => terminations.push(error),
			});
			const pending = client.request("model/list", {});
			client.close();
			await expect(pending).rejects.toThrow("Codex app-server is closed");
			await new Promise((resolve) => setTimeout(resolve, 30));
			expect(terminations).toEqual([]);
		} finally {
			client?.close();
			rmSync(directory, { recursive: true, force: true });
		}
	});
});
