import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import {
	__testing,
	issueMcpGatewaySession,
	mcpGatewayDiagnostics,
} from "@zuse/agents/mcp-gateway";
import { afterAll, describe, expect, test, vi } from "vitest";
import { pluginCliEnv } from "../../src/drivers/plugin-tools.ts";

const mcpPost = async (
	url: string,
	token: string,
	body: Record<string, unknown>,
) => {
	const res = await fetch(url, {
		method: "POST",
		headers: {
			authorization: `Bearer ${token}`,
			accept: "application/json, text/event-stream",
			"content-type": "application/json",
		},
		body: JSON.stringify(body),
	});
	const text = await res.text();
	const dataLine = text.split("\n").find((line) => line.startsWith("data: "));
	return {
		status: res.status,
		body:
			dataLine === undefined
				? null
				: (JSON.parse(dataLine.slice("data: ".length)) as {
						readonly result?: unknown;
						readonly error?: unknown;
					}),
		raw: text,
	};
};

const listTools = async (url: string, token: string) =>
	mcpPost(url, token, {
		jsonrpc: "2.0",
		id: 1,
		method: "tools/list",
		params: {},
	});

const callTool = async (
	url: string,
	token: string,
	name: string,
	args: Record<string, unknown>,
) =>
	mcpPost(url, token, {
		jsonrpc: "2.0",
		id: 2,
		method: "tools/call",
		params: { name, arguments: args },
	});

const baseDeps = {
	emitUi: async () => ({ ok: true as const, messageId: "ui-message" }),
	createWorktree: async () => ({
		ok: false as const,
		error: "unused",
	}),
	createThread: async () => ({
		ok: true as const,
		chatId: "chat_1",
		sessionId: "spawned_1",
		title: "Spawned",
		worktreeId: "wt_1",
		path: "/tmp/wt",
		branch: "branch",
	}),
	createSession: async () => ({
		ok: false as const,
		error: "unused",
	}),
	sendToThread: async () => ({
		ok: false as const,
		error: "unused",
	}),
	readThread: async () => ({
		ok: false as const,
		error: "unused",
	}),
	listThreads: async () => ({ ok: true as const, threads: [] }),
	listModels: async () => ({ ok: true as const, providers: [] }),
	whoami: async () => ({
		sessionId: "session_1",
		chatId: "chat_1",
		projectId: "project_1",
		worktreeId: null,
		providerId: "codex",
		model: "model",
		autonomyLevel: "approval-gated",
	}),
};

const ONE_PIXEL_PNG = Buffer.from(
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
	"base64",
);

afterAll(async () => {
	await __testing.closeServer();
});

describe("MCP gateway", () => {
	test("cancelled issuance cannot replace a live session", async () => {
		const input = {
			sessionId: "cancelled-issuance",
			scopes: { browser: false, orchestration: false },
			ctx: {},
		};
		const live = await issueMcpGatewaySession(input);
		try {
			const abort = new AbortController();
			const pending = issueMcpGatewaySession(input, abort.signal);
			abort.abort();
			await expect(pending).rejects.toThrow();
			expect((await listTools(live.endpoint, live.token)).status).toBe(200);
		} finally {
			await live.close();
		}
	});

	test("keeps the MCP tool call unresolved until device approval and execution finish", async () => {
		let approved = false;
		let requests = 0;
		let finished = false;
		const command = {
			id: "cmd",
			accountId: "account",
			workspaceId: "cloud",
			chatId: "chat",
			chatTitle: "Test",
			grantEpoch: 0,
			sessionId: "session",
			deviceId: "mac",
			deviceName: "Mac",
			command: "pwd",
			cwd: "/Users/test",
			stdout: "",
			stderr: "",
			exitCode: null,
			truncated: false,
			createdAt: 0,
		};
		const issued = await issueMcpGatewaySession({
			sessionId: "device-wait-test",
			scopes: { browser: false, orchestration: false, deviceCommands: true },
			ctx: {
				deviceCommands: {
					request: async () => {
						requests++;
						return {
							...command,
							state: approved ? ("completed" as const) : ("pending" as const),
							stdout: approved ? "/Users/test" : "",
							exitCode: approved ? 0 : null,
						};
					},
				},
			},
		});
		try {
			const running = callTool(
				issued.endpoint,
				issued.token,
				"local_command_execute",
				{ command: "pwd", cwd: "/Users/test" },
			).then((result) => {
				finished = true;
				return result;
			});
			await expect.poll(() => requests).toBeGreaterThan(0);
			expect(finished).toBe(false);
			approved = true;
			const response = await running;
			expect(response.status).toBe(200);
			expect(response.raw).toContain("/Users/test");
			expect(response.raw).not.toContain("pending");
		} finally {
			await issued.close();
		}
	});
	test("rejects missing, malformed, invalid, and revoked bearer tokens", async () => {
		const issued = await issueMcpGatewaySession({
			sessionId: "auth-test",
			scopes: { browser: true, orchestration: false },
			ctx: {
				browser: {
					send: async () => ({ id: "test", ok: true, snapshot: "[]" }),
					requestPermission: async () => ({ _tag: "AllowOnce" }),
					getRuntimeMode: () => "full-access",
					getPermissionMode: () => "default",
				},
			},
		});

		expect(
			await fetch(issued.endpoint, { method: "POST" }).then(
				(res) => res.status,
			),
		).toBe(401);
		expect(
			await fetch(issued.endpoint, {
				method: "POST",
				headers: { authorization: "bearer nope" },
			}).then((res) => res.status),
		).toBe(401);
		expect(
			await fetch(issued.endpoint, {
				method: "POST",
				headers: { authorization: "Bearer invalid" },
			}).then((res) => res.status),
		).toBe(401);

		await issued.close();
		expect(
			await fetch(issued.endpoint, {
				method: "POST",
				headers: { authorization: `Bearer ${issued.token}` },
			}).then((res) => res.status),
		).toBe(401);
	});

	test("keeps a live provider authenticated across idle periods and long sessions", async () => {
		const issued = await issueMcpGatewaySession({
			sessionId: "long-lived-test",
			scopes: { browser: false, orchestration: true },
			ctx: {
				orchestration: {
					deps: baseDeps,
					requestPermission: async () => ({ _tag: "AllowOnce" }),
					getRuntimeMode: () => "full-access",
					getPermissionMode: () => "default",
				},
			},
		});
		const issuedAt = Date.now();
		const now = vi.spyOn(Date, "now");
		try {
			const activeSessionCount = mcpGatewayDiagnostics().activeSessionCount;
			for (const elapsed of [31 * 60_000, 9 * 60 * 60_000]) {
				now.mockReturnValue(issuedAt + elapsed);
				expect(mcpGatewayDiagnostics().activeSessionCount).toBe(
					activeSessionCount,
				);
				const response = await callTool(
					issued.endpoint,
					issued.token,
					"whoami",
					{},
				);
				expect(response.status).toBe(200);
				expect(response.raw).toContain("session_1");
			}
			await issued.close();
			expect((await listTools(issued.endpoint, issued.token)).status).toBe(401);
		} finally {
			now.mockRestore();
			await issued.close();
		}
	});

	test("an obsolete session handle cannot revoke its replacement", async () => {
		const first = await issueMcpGatewaySession({
			sessionId: "replacement-test",
			scopes: { browser: false, orchestration: true },
			ctx: {
				orchestration: {
					deps: baseDeps,
					requestPermission: async () => ({ _tag: "AllowOnce" }),
					getRuntimeMode: () => "full-access",
					getPermissionMode: () => "default",
				},
			},
		});
		const replacement = await issueMcpGatewaySession({
			sessionId: "replacement-test",
			scopes: { browser: false, orchestration: true },
			ctx: {
				orchestration: {
					deps: baseDeps,
					requestPermission: async () => ({ _tag: "AllowOnce" }),
					getRuntimeMode: () => "full-access",
					getPermissionMode: () => "default",
				},
			},
		});

		expect((await listTools(first.endpoint, first.token)).status).toBe(401);
		await first.close();

		expect(
			(await callTool(replacement.endpoint, replacement.token, "whoami", {}))
				.status,
		).toBe(200);
		expect(
			(
				await callTool(
					replacement.endpoint,
					replacement.token,
					"list_threads",
					{},
				)
			).status,
		).toBe(200);
	});

	test("returns 404 for unknown paths", async () => {
		const issued = await issueMcpGatewaySession({
			sessionId: "scope-test",
			scopes: { browser: true, orchestration: false },
			ctx: {
				browser: {
					send: async () => ({ id: "test", ok: true, snapshot: "[]" }),
					requestPermission: async () => ({ _tag: "AllowOnce" }),
					getRuntimeMode: () => "full-access",
					getPermissionMode: () => "default",
				},
			},
		});

		expect(
			await fetch(issued.endpoint.replace("/mcp", "/missing"), {
				headers: { authorization: `Bearer ${issued.token}` },
			}).then((res) => res.status),
		).toBe(404);
	});

	test("lists enabled toolkits through one provider-neutral server config", async () => {
		const issued = await issueMcpGatewaySession({
			sessionId: "browser-list-test",
			scopes: { browser: true, orchestration: false, images: true },
			ctx: {
				browser: {
					send: async () => ({ id: "test", ok: true, snapshot: "[]" }),
					requestPermission: async () => ({ _tag: "AllowOnce" }),
					getRuntimeMode: () => "full-access",
					getPermissionMode: () => "default",
				},
				images: { cwd: "/tmp" },
			},
		});

		const listed = await listTools(issued.endpoint, issued.token);
		expect(listed.status).toBe(200);
		const tools = (
			listed.body?.result as { tools?: Array<{ name: string }> } | undefined
		)?.tools;
		expect(tools?.some((tool) => tool.name === "browser_navigate")).toBe(true);
		expect(tools?.some((tool) => tool.name === "view_image")).toBe(true);
		expect(tools?.some((tool) => tool.name === "create_thread")).toBe(false);
		expect(issued.serverConfig).toEqual({
			type: "http",
			name: "zuse",
			url: issued.endpoint,
			headers: [{ name: "Authorization", value: `Bearer ${issued.token}` }],
		});
		expect(issued.codexServerConfig).toEqual({
			url: issued.endpoint,
			bearer_token_env_var: "ZUSE_MCP_TOKEN",
			enabled: true,
		});
	});

	test("serves the workspace-scoped view_image tool as multimodal content", async () => {
		const cwd = await mkdtemp(path.join(tmpdir(), "zuse-image-gateway-"));
		const imagePath = path.join(cwd, "screen.png");
		await writeFile(imagePath, ONE_PIXEL_PNG);
		const issued = await issueMcpGatewaySession({
			sessionId: "image-tool-test",
			scopes: { browser: false, orchestration: false, images: true },
			ctx: { images: { cwd } },
		});

		try {
			const listed = await listTools(issued.endpoint, issued.token);
			expect(listed.body?.result).toMatchObject({
				tools: [{ name: "view_image" }],
			});
			const viewed = await callTool(
				issued.endpoint,
				issued.token,
				"view_image",
				{ path: imagePath },
			);
			expect(viewed.body?.result).toMatchObject({
				content: [
					{
						type: "image",
						mimeType: "image/png",
						data: ONE_PIXEL_PNG.toString("base64"),
					},
					{ type: "text", text: "Viewed image: screen.png" },
				],
			});
		} finally {
			await issued.close();
			await rm(cwd, { recursive: true, force: true });
		}
	});

	test("dispatches tool calls to the issuing session context", async () => {
		const calls: string[] = [];
		const first = await issueMcpGatewaySession({
			sessionId: "dispatch-a",
			scopes: { browser: true, orchestration: false },
			ctx: {
				browser: {
					send: async (command) => {
						calls.push(`a:${command._tag}`);
						return { id: "test", ok: true, snapshot: "[]" };
					},
					requestPermission: async () => ({ _tag: "AllowOnce" }),
					getRuntimeMode: () => "full-access",
					getPermissionMode: () => "default",
				},
			},
		});
		const second = await issueMcpGatewaySession({
			sessionId: "dispatch-b",
			scopes: { browser: true, orchestration: false },
			ctx: {
				browser: {
					send: async (command) => {
						calls.push(`b:${command._tag}`);
						return { id: "test", ok: true, snapshot: "[]" };
					},
					requestPermission: async () => ({ _tag: "AllowOnce" }),
					getRuntimeMode: () => "full-access",
					getPermissionMode: () => "default",
				},
			},
		});

		await callTool(second.endpoint, second.token, "browser_snapshot", {});
		await callTool(first.endpoint, first.token, "browser_snapshot", {});
		expect(calls).toEqual(["b:Snapshot", "a:Snapshot"]);
	});

	test("serves a session's own toolsets only to that session", async () => {
		const calls: string[] = [];
		const toolset = {
			definitions: [
				{
					name: "guide_ping",
					description: "Test tool",
					inputSchema: { type: "object", properties: {} },
					annotations: { readOnlyHint: true },
				},
			],
			call: async (name: string, args: Record<string, unknown>) => {
				calls.push(`${name}:${JSON.stringify(args)}`);
				return { content: [{ type: "text" as const, text: "pong" }] };
			},
		};
		const owner = await issueMcpGatewaySession({
			sessionId: "toolset-owner",
			scopes: { browser: true, orchestration: false },
			ctx: { toolsets: [toolset] },
		});
		const other = await issueMcpGatewaySession({
			sessionId: "toolset-other",
			scopes: { browser: false, orchestration: false },
			ctx: {},
		});
		try {
			const listed = (await listTools(owner.endpoint, owner.token)).body
				?.result as { tools: Array<{ name: string }> };
			expect(listed.tools.map((tool) => tool.name)).toContain("guide_ping");
			const called = await callTool(owner.endpoint, owner.token, "guide_ping", {
				a: 1,
			});
			expect(called.body?.result).toEqual({
				content: [{ type: "text", text: "pong" }],
			});
			expect(calls).toEqual(['guide_ping:{"a":1}']);

			const otherListed = (await listTools(other.endpoint, other.token)).body
				?.result as { tools: Array<{ name: string }> };
			expect(otherListed.tools.map((tool) => tool.name)).not.toContain(
				"guide_ping",
			);
			const refused = await callTool(
				other.endpoint,
				other.token,
				"guide_ping",
				{},
			);
			expect(refused.body?.result).toMatchObject({ isError: true });
			expect(calls).toHaveLength(1);
		} finally {
			await owner.close();
			await other.close();
		}
	});

	test("emit_ui is available through the gateway without a mutation approval", async () => {
		const emitUi = vi.fn(async () => ({
			ok: true as const,
			messageId: "ui-message",
		}));
		const permission = vi.fn(async () => ({ _tag: "Deny" as const }));
		const issued = await issueMcpGatewaySession({
			sessionId: "emit-ui",
			scopes: { browser: false, orchestration: true },
			ctx: {
				orchestration: {
					deps: { ...baseDeps, emitUi },
					requestPermission: permission,
					getRuntimeMode: () => "approval-required",
					getPermissionMode: () => "default",
				},
			},
		});
		try {
			const spec = 'root = Text("Gateway UI")';
			expect((await listTools(issued.endpoint, issued.token)).raw).toContain(
				"emit_ui",
			);
			const result = await callTool(issued.endpoint, issued.token, "emit_ui", {
				spec,
			});
			expect(result.status).toBe(200);
			expect(result.raw).toContain("ui-message");
			expect(emitUi).toHaveBeenCalledExactlyOnceWith({ spec });
			expect(permission).not.toHaveBeenCalled();
		} finally {
			await issued.close();
		}
	});

	test("permission denial for mutating orchestration tools returns an MCP error result", async () => {
		const issued = await issueMcpGatewaySession({
			sessionId: "deny-test",
			scopes: { browser: false, orchestration: true },
			ctx: {
				orchestration: {
					deps: baseDeps,
					requestPermission: async () => ({ _tag: "Deny" }),
					getRuntimeMode: () => "approval-required",
					getPermissionMode: () => "default",
				},
			},
		});

		const result = await callTool(
			issued.endpoint,
			issued.token,
			"create_thread",
			{ task: "do work" },
		);
		expect(result.status).toBe(200);
		expect(result.body?.result).toMatchObject({
			isError: true,
			content: [
				{
					type: "text",
					text: "create_thread failed: Permission denied for create_thread.",
				},
			],
		});
	});
});

test("native plugin bridge enforces permissions and revokes its session token", async () => {
	const request = vi.fn(async () => ({ ok: true }));
	const lease = await issueMcpGatewaySession({
		sessionId: "plugin-bridge-test",
		scopes: { browser: false, orchestration: false, plugins: true },
		ctx: {
			plugins: {
				client: { request },
				getRuntimeMode: () => "approval-required",
				getPermissionMode: () => "default",
				requestPermission: async () => ({ _tag: "Deny" }),
			},
		},
	});
	const endpoint = new URL("/plugins", lease.endpoint);
	const invoke = (token: string) =>
		fetch(endpoint, {
			method: "POST",
			headers: {
				authorization: `Bearer ${token}`,
				"content-type": "application/json",
			},
			body: JSON.stringify({
				name: "plugins_call",
				args: { address: "tools.linear.user.work.update", arguments: {} },
			}),
		});
	try {
		expect((await invoke("wrong")).status).toBe(401);
		expect((await invoke(lease.token)).status).toBe(500);
		expect(request).not.toHaveBeenCalled();
		const discovery = await listTools(lease.endpoint, lease.token);
		expect(discovery.raw).toContain("plugins_search");
		expect(discovery.raw).toContain("plugins_list");
		const plugins = await fetch(endpoint, {
			method: "POST",
			headers: {
				authorization: `Bearer ${lease.token}`,
				"content-type": "application/json",
			},
			body: JSON.stringify({ name: "plugins_list", args: {} }),
		});
		expect(plugins.status).toBe(200);
		expect(request).toHaveBeenCalledWith({ action: "list" });
	} finally {
		await lease.close();
	}
	expect((await invoke(lease.token)).status).toBe(401);
});

test("exposes visuals only in scoped sessions and binds publication to the caller", async () => {
	const render = vi.fn(async () => ({
		attachmentId: "saved",
		title: "Chart",
		height: 100,
	}));
	const client = { render, preview: vi.fn() };
	const issued = await issueMcpGatewaySession({
		sessionId: "visual-owner",
		scopes: { browser: false, orchestration: false, html: true },
		ctx: { html: { client, cwd: "/repo" } },
	});
	const excluded = await issueMcpGatewaySession({
		sessionId: "other",
		scopes: { browser: false, orchestration: false },
		ctx: { html: { client, cwd: "/other" } },
	});
	try {
		expect((await listTools(issued.endpoint, issued.token)).raw).toContain(
			"html_preview",
		);
		expect(
			(await listTools(excluded.endpoint, excluded.token)).raw,
		).not.toContain("html_render");
		const input = {
			html: "<h1>Chart</h1>",
			title: "Chart",
			height: 100,
			sessionId: "forged",
		};
		expect(
			(await callTool(issued.endpoint, issued.token, "html_render", input)).raw,
		).toContain("saved");
		expect(render).toHaveBeenCalledWith(
			"visual-owner",
			"/repo",
			expect.anything(),
			expect.any(AbortSignal),
		);
		expect(
			(await callTool(excluded.endpoint, excluded.token, "html_render", input))
				.raw,
		).toContain("Unknown tool");
		render.mockRejectedValueOnce(new Error("Storage failed"));
		expect(
			(await callTool(issued.endpoint, issued.token, "html_render", input)).raw,
		).toContain('"isError":true');
	} finally {
		await issued.close();
		await excluded.close();
	}
});

test("orchestration CLI shares session authentication, scope, and permission checks", async () => {
	const requestPermission = vi.fn(async () => ({ _tag: "Deny" as const }));
	const createSession = vi.fn(baseDeps.createSession);
	const issued = await issueMcpGatewaySession({
		sessionId: "cli-orchestration",
		scopes: { browser: false, orchestration: true },
		ctx: {
			orchestration: {
				deps: { ...baseDeps, createSession },
				requestPermission,
				getRuntimeMode: () => "approval-required",
				getPermissionMode: () => "default",
			},
		},
	});
	const post = (token: string, body: unknown) =>
		fetch(new URL("/orchestration", issued.endpoint), {
			method: "POST",
			headers: {
				authorization: `Bearer ${token}`,
				"content-type": "application/json",
			},
			body: JSON.stringify(body),
		});
	try {
		expect((await post("wrong", { name: "tools/list" })).status).toBe(401);
		const listed = await post(issued.token, { name: "tools/list" });
		expect(listed.status).toBe(200);
		expect(await listed.json()).toMatchObject({
			tools: expect.arrayContaining([
				expect.objectContaining({ name: "create_session" }),
			]),
		});
		await post(issued.token, {
			name: "create_session",
			args: { prompt: "review", chatId: "chat_1" },
		});
		expect(requestPermission).toHaveBeenCalled();
		expect(createSession).not.toHaveBeenCalled();
	} finally {
		await issued.close();
	}
	expect((await post(issued.token, { name: "tools/list" })).status).toBe(401);
});

test("provider shell credentials select independent parent and child orchestration sessions", async () => {
	const delegateTask = vi.fn(async () => ({
		ok: true as const,
		taskId: "shell-child",
		sessionId: "shell-child",
		status: "running",
		workState: "working" as const,
	}));
	const issue = (sessionId: string) =>
		issueMcpGatewaySession({
			sessionId,
			scopes: { browser: false, orchestration: true },
			ctx: {
				orchestration: {
					deps: {
						...baseDeps,
						delegateTask,
						whoami: async () => ({
							...(await baseDeps.whoami()),
							sessionId,
						}),
					},
					requestPermission: async () => ({ _tag: "AllowOnce" as const }),
					getRuntimeMode: () => "full-access",
					getPermissionMode: () => "default",
				},
			},
		});
	const parent = await issue("shell-parent");
	const child = await issue("shell-child");
	const request = async (session: typeof parent, name: string, args = {}) => {
		const { stdout } = await promisify(execFile)(
			process.execPath,
			[
				"--input-type=module",
				"-e",
				`
			const response = await fetch(process.env.ZUSE_ORCHESTRATION_URL, {
				method: "POST",
				headers: { authorization: "Bearer " + process.env.ZUSE_ORCHESTRATION_AUTH, "content-type": "application/json" },
				body: process.argv[1],
			});
			console.log(JSON.stringify({ status: response.status, body: await response.text() }));
		`,
				JSON.stringify({ name, args }),
			],
			{
				env: Object.fromEntries(
					Object.entries({
						...process.env,
						...pluginCliEnv(session.endpoint, session.token),
					}).filter(([key]) => !/KEY|SECRET|TOKEN/i.test(key)),
				),
				timeout: 10_000,
			},
		);
		return JSON.parse(stdout) as { status: number; body: string };
	};
	const decoded = (response: { status: number; body: string }) => {
		expect(response.status).toBe(200);
		const result = JSON.parse(response.body);
		return JSON.parse(result.content[0].text);
	};
	try {
		const listed = await request(parent, "tools/list");
		expect(listed.status).toBe(200);
		expect(JSON.parse(listed.body).tools).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ name: "delegate_task" }),
			]),
		);
		expect(decoded(await request(parent, "whoami"))).toMatchObject({
			sessionId: "shell-parent",
		});
		expect(
			decoded(
				await request(parent, "delegate_task", {
					task: "review",
					clientRequestId: "request-1",
				}),
			),
		).toMatchObject({ ok: true, taskId: "shell-child" });
		expect(delegateTask).toHaveBeenCalledWith({
			task: "review",
			clientRequestId: "request-1",
		});
		expect(decoded(await request(child, "whoami"))).toMatchObject({
			sessionId: "shell-child",
		});
		await parent.close();
		expect((await request(parent, "whoami")).status).toBe(401);
		expect(decoded(await request(child, "whoami"))).toMatchObject({
			sessionId: "shell-child",
		});
	} finally {
		await parent.close();
		await child.close();
	}
	expect((await request(child, "whoami")).status).toBe(401);
});
