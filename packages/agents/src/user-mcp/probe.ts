import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { Effect } from "effect";

import type { ResolvedMcpServer } from "./types.ts";

/**
 * Outcome of one connection attempt against a user MCP server. `state`
 * deliberately matches the wire `McpServerState` subset a probe can produce
 * (a probe never yields "connecting"/"disabled" — those are inventory
 * states).
 */
export interface McpProbeResult {
	readonly state: "connected" | "error" | "needs-auth";
	readonly toolNames: ReadonlyArray<string>;
	readonly error: string | null;
	/**
	 * Set when `state === "needs-auth"`: "oauth" when the server answered
	 * with an OAuth challenge (WWW-Authenticate / 401 on a bare request),
	 * "token" when a static credential is referenced but missing.
	 */
	readonly authMethod: "oauth" | "token" | null;
}

const connected = (toolNames: ReadonlyArray<string>): McpProbeResult => ({
	state: "connected",
	toolNames,
	error: null,
	authMethod: null,
});

const needsAuth = (method: "oauth" | "token"): McpProbeResult => ({
	state: "needs-auth",
	toolNames: [],
	error: null,
	authMethod: method,
});

const failed = (error: string): McpProbeResult => ({
	state: "error",
	toolNames: [],
	error,
	authMethod: null,
});

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null;

/**
 * Flatten an error and its `cause` chain (fetch buries ECONNREFUSED two
 * levels deep) into one searchable string of messages + codes.
 */
const failureText = (cause: unknown): string => {
	const parts: string[] = [];
	let current: unknown = cause;
	for (let depth = 0; depth < 5 && current !== undefined; depth++) {
		if (current instanceof Error) parts.push(current.message);
		else if (typeof current === "string") parts.push(current);
		if (isRecord(current)) {
			if (typeof current.code === "string" || typeof current.code === "number")
				parts.push(String(current.code));
			if (Array.isArray(current.errors)) {
				for (const nested of current.errors as unknown[]) {
					parts.push(failureText(nested));
				}
			}
			current = current.cause;
		} else {
			break;
		}
	}
	return parts.join(" | ");
};

/**
 * The SDK surfaces a 401 as `UnauthorizedError` when an auth provider is
 * configured and as `StreamableHTTPError`/`SseError` with `code: 401`
 * otherwise; stdio spawn failures bubble up as ENOENT/EACCES. Everything
 * else is a plain connection error.
 */
const classifyFailure = (
	server: ResolvedMcpServer,
	cause: unknown,
): McpProbeResult => {
	if (cause instanceof UnauthorizedError) return needsAuth("oauth");
	const message = cause instanceof Error ? cause.message : String(cause);
	const text = failureText(cause);
	if (isRecord(cause) && (cause.code === 401 || /\b401\b/.test(text))) {
		return needsAuth("oauth");
	}
	if (isRecord(cause) && (cause.code === 403 || /\b403\b/.test(text))) {
		return needsAuth("token");
	}
	if (/ENOENT/.test(text)) {
		return failed(`command not found: ${server.command ?? ""}`.trim());
	}
	if (/EACCES/.test(text)) {
		return failed(`command not executable: ${server.command ?? ""}`.trim());
	}
	if (/ECONNREFUSED/.test(text)) return failed("connection refused");
	if (/TimeoutException|timed? ?out/i.test(text)) {
		return failed("timed out waiting for the server");
	}
	return failed(message);
};

const makeTransport = (
	server: ResolvedMcpServer,
	kind: "stdio" | "streamable-http" | "sse",
): Transport => {
	if (kind === "stdio") {
		return new StdioClientTransport({
			command: server.command ?? "",
			args: [...(server.args ?? [])],
			// Merge over the parent env like the driver spawn will, so a server
			// that needs PATH/HOME behaves the same in probe and session.
			env: {
				...(process.env as Record<string, string>),
				...(server.env ?? {}),
			},
			stderr: "ignore",
		});
	}
	const url = new URL(server.url ?? "");
	const headers = { ...(server.headers ?? {}) };
	if (kind === "sse") {
		return new SSEClientTransport(url, {
			requestInit: { headers },
			// The SSE GET goes through EventSource, which cannot carry custom
			// headers — inject them via a fetch override instead.
			eventSourceInit: {
				fetch: (input, init) =>
					fetch(input, {
						...init,
						headers: {
							...Object.fromEntries(new Headers(init?.headers).entries()),
							...headers,
						},
					}),
			},
		});
	}
	return new StreamableHTTPClientTransport(url, {
		requestInit: { headers },
	});
};

const attempt = async (
	server: ResolvedMcpServer,
	kind: "stdio" | "streamable-http" | "sse",
): Promise<ReadonlyArray<string>> => {
	const client = new Client({ name: "zuse-mcp-probe", version: "1.0.0" });
	const transport = makeTransport(server, kind);
	try {
		await client.connect(transport);
		const tools = await client.listTools();
		return tools.tools.map((tool) => tool.name);
	} finally {
		await client.close().catch(() => undefined);
	}
};

/**
 * Connect to one user MCP server, list its tools, and disconnect. HTTP
 * servers are tried over Streamable HTTP first with a legacy-SSE fallback
 * (unless the config explicitly says `sse`); an auth challenge on either
 * attempt wins over the fallback's transport error so the UI shows
 * "auth required" rather than a confusing protocol failure.
 */
export const probeMcpServer = (
	server: ResolvedMcpServer,
	timeoutMs = 10_000,
): Effect.Effect<McpProbeResult> =>
	Effect.tryPromise({
		try: async (): Promise<McpProbeResult> => {
			if (server.transport === "stdio") {
				try {
					return connected(await attempt(server, "stdio"));
				} catch (cause) {
					return classifyFailure(server, cause);
				}
			}
			const order: ReadonlyArray<"streamable-http" | "sse"> =
				server.transport === "sse"
					? ["sse", "streamable-http"]
					: ["streamable-http", "sse"];
			let first: McpProbeResult | null = null;
			for (const kind of order) {
				try {
					return connected(await attempt(server, kind));
				} catch (cause) {
					const result = classifyFailure(server, cause);
					if (result.state === "needs-auth") return result;
					first = first ?? result;
				}
			}
			return first ?? failed("unreachable");
		},
		catch: (cause) => classifyFailure(server, cause),
	}).pipe(
		Effect.catch((result) => Effect.succeed(result)),
		Effect.timeoutOption(timeoutMs),
		Effect.map((option) =>
			option._tag === "Some"
				? option.value
				: failed("timed out waiting for the server"),
		),
	);
