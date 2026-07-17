import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { __testing, issueMcpGatewaySession } from "@zuse/agents/mcp-gateway";
import { afterAll, describe, expect, test } from "vitest";

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
			await fetch(issued.endpoints.browser, { method: "POST" }).then(
				(res) => res.status,
			),
		).toBe(401);
		expect(
			await fetch(issued.endpoints.browser, {
				method: "POST",
				headers: { authorization: "bearer nope" },
			}).then((res) => res.status),
		).toBe(401);
		expect(
			await fetch(issued.endpoints.browser, {
				method: "POST",
				headers: { authorization: "Bearer invalid" },
			}).then((res) => res.status),
		).toBe(401);

		await issued.close();
		expect(
			await fetch(issued.endpoints.browser, {
				method: "POST",
				headers: { authorization: `Bearer ${issued.token}` },
			}).then((res) => res.status),
		).toBe(401);
	});

	test("returns 404 for unknown paths and unscoped toolkits", async () => {
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
			await fetch(
				issued.endpoints.browser.replace("/mcp/zuse", "/mcp/missing"),
				{ headers: { authorization: `Bearer ${issued.token}` } },
			).then((res) => res.status),
		).toBe(404);
		expect(
			await fetch(issued.endpoints.orchestration, {
				method: "POST",
				headers: { authorization: `Bearer ${issued.token}` },
			}).then((res) => res.status),
		).toBe(401);
	});

	test("lists only the scoped browser toolkit", async () => {
		const issued = await issueMcpGatewaySession({
			sessionId: "browser-list-test",
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

		const listed = await listTools(issued.endpoints.browser, issued.token);
		expect(listed.status).toBe(200);
		const tools = (
			listed.body?.result as { tools?: Array<{ name: string }> } | undefined
		)?.tools;
		expect(tools?.some((tool) => tool.name === "browser_navigate")).toBe(true);
		expect(tools?.some((tool) => tool.name === "create_thread")).toBe(false);
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
			const listed = await listTools(issued.endpoints.images, issued.token);
			expect(listed.body?.result).toMatchObject({
				tools: [{ name: "view_image" }],
			});
			const viewed = await callTool(
				issued.endpoints.images,
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

		await callTool(
			second.endpoints.browser,
			second.token,
			"browser_snapshot",
			{},
		);
		await callTool(
			first.endpoints.browser,
			first.token,
			"browser_snapshot",
			{},
		);
		expect(calls).toEqual(["b:Snapshot", "a:Snapshot"]);
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
			issued.endpoints.orchestration,
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
