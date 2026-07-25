import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import {
	createServer,
	type Server as HttpServer,
	type IncomingMessage,
	type ServerResponse,
} from "node:http";

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
	CallToolRequestSchema,
	ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

import {
	BROWSER_MCP_TOOLS,
	type BrowserMcpToolOptions,
	handleBrowserTool,
} from "../drivers/browser-mcp-tools.ts";
import {
	handleImageTool,
	IMAGE_MCP_TOOLS,
	type ImageMcpToolOptions,
} from "../drivers/image-mcp-tools.ts";
import {
	callLinearTool,
	ensureLinearToolPermission,
	isLinearToolName,
	LINEAR_MCP_TOOLS,
	type LinearPermissionOptions,
	type LinearToolDeps,
} from "../drivers/linear-tools.ts";
import {
	callOrchestrationTool,
	ensureOrchestrationPermission,
	isOrchestrationToolName,
	ORCHESTRATION_MCP_TOOLS,
	type OrchestrationPermissionOptions,
	type OrchestrationToolDeps,
} from "../drivers/orchestration-tools.ts";

type JsonObject = Record<string, unknown>;

const IDLE_TIMEOUT_MS = 30 * 60 * 1_000;
const MAX_LIFETIME_MS = 8 * 60 * 60 * 1_000;

export const APP_MCP_SERVER_NAME = "zuse";
const APP_MCP_PATH = "/mcp";

export interface AppMcpQuestion {
	readonly question: string;
	readonly options: ReadonlyArray<string>;
	readonly multiSelect?: boolean;
}

export interface AppMcpQuestionAnswer {
	readonly questionIndex: number;
	readonly selected: ReadonlyArray<number>;
	readonly other?: string;
}

export interface AppMcpInteractionOptions {
	readonly askUserQuestion: (
		questions: ReadonlyArray<AppMcpQuestion>,
	) => Promise<ReadonlyArray<AppMcpQuestionAnswer> | null>;
}

export interface McpGatewaySessionContext {
	readonly browser?: BrowserMcpToolOptions;
	readonly orchestration?: OrchestrationPermissionOptions & {
		readonly deps: OrchestrationToolDeps;
	};
	readonly linear?: LinearPermissionOptions & { readonly deps: LinearToolDeps };
	readonly images?: ImageMcpToolOptions;
	readonly interaction?: AppMcpInteractionOptions;
}

export interface McpGatewayIssueInput {
	readonly sessionId: string;
	readonly scopes: {
		readonly browser: boolean;
		readonly orchestration: boolean;
		readonly linear?: boolean;
		readonly images?: boolean;
		readonly interaction?: boolean;
	};
	readonly ctx: McpGatewaySessionContext;
}

export interface McpGatewaySession {
	readonly token: string;
	readonly endpoint: string;
	readonly serverConfig: AcpHttpMcpServerConfig;
	readonly codexServerConfig: CodexHttpMcpServerConfig;
	readonly close: () => Promise<void>;
}

export interface AcpHttpMcpServerConfig {
	readonly type: "http";
	readonly name: string;
	readonly url: string;
	readonly headers: ReadonlyArray<{
		readonly name: string;
		readonly value: string;
	}>;
}

export interface CodexHttpMcpServerConfig {
	readonly url: string;
	readonly bearer_token_env_var: "ZUSE_MCP_TOKEN";
	readonly enabled: true;
}

interface RegistryRecord {
	readonly sessionId: string;
	readonly tokenHash: string;
	readonly issuedAt: number;
	readonly expiresAt: number;
	readonly scopes: {
		readonly browser: boolean;
		readonly orchestration: boolean;
		readonly linear?: boolean;
		readonly images?: boolean;
		readonly interaction?: boolean;
	};
	readonly ctx: McpGatewaySessionContext;
	readonly lastUsedAt: number;
}

let serverPromise: Promise<{
	readonly server: HttpServer;
	readonly port: number;
}> | null = null;
const recordsBySession = new Map<string, RegistryRecord>();
const recordsByHash = new Map<string, RegistryRecord>();

const tokenHash = (token: string): string =>
	createHash("sha256").update(token).digest("hex");

const constantTimeEqual = (a: string, b: string): boolean => {
	const aBuf = Buffer.from(a, "hex");
	const bBuf = Buffer.from(b, "hex");
	return aBuf.length === bBuf.length && timingSafeEqual(aBuf, bBuf);
};

export const parseMcpBearerAuthorization = (
	authorization: string | undefined,
): string | null => {
	if (authorization === undefined) return null;
	const match = /^Bearer ([A-Za-z0-9_-]+)$/u.exec(authorization);
	return match?.[1] ?? null;
};

const pruneExpired = (now = Date.now()): void => {
	for (const record of recordsBySession.values()) {
		if (now > record.expiresAt || now - record.lastUsedAt > IDLE_TIMEOUT_MS) {
			recordsBySession.delete(record.sessionId);
			recordsByHash.delete(record.tokenHash);
		}
	}
};

const resolveRecord = (rawToken: string): RegistryRecord | null => {
	pruneExpired();
	const hash = tokenHash(rawToken);
	const record = recordsByHash.get(hash);
	if (record === undefined || !constantTimeEqual(hash, record.tokenHash)) {
		return null;
	}
	const refreshed = { ...record, lastUsedAt: Date.now() };
	recordsBySession.set(refreshed.sessionId, refreshed);
	recordsByHash.set(refreshed.tokenHash, refreshed);
	return refreshed;
};

const writeText = (res: ServerResponse, status: number, body: string): void => {
	res.writeHead(status, {
		"content-type": "text/plain; charset=utf-8",
		"cache-control": "no-store",
	});
	res.end(body);
};

const unauthorized = (res: ServerResponse): void => {
	res.writeHead(401, {
		"content-type": "text/plain; charset=utf-8",
		"cache-control": "no-store",
		"www-authenticate": "Bearer",
	});
	res.end("unauthorized");
};

const asJsonObject = (value: unknown): JsonObject =>
	value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as JsonObject)
		: {};

const toolResultFromError = (toolName: string, cause: unknown) => ({
	content: [
		{
			type: "text" as const,
			text: `${toolName} failed: ${
				cause instanceof Error ? cause.message : String(cause)
			}`,
		},
	],
	isError: true as const,
});

const ASK_USER_QUESTION_TOOL = {
	name: "ask_user_question",
	description:
		"Ask the user one or more structured questions when a decision cannot be inferred from context. Do not include an Other option; the app provides it.",
	inputSchema: {
		type: "object" as const,
		properties: {
			questions: {
				type: "array" as const,
				minItems: 1,
				items: {
					type: "object" as const,
					properties: {
						question: { type: "string" as const },
						options: {
							type: "array" as const,
							items: { type: "string" as const },
						},
						multiSelect: { type: "boolean" as const },
					},
					required: ["question", "options"],
					additionalProperties: false,
				},
			},
		},
		required: ["questions"],
		additionalProperties: false,
	},
};

const parseQuestions = (args: JsonObject): ReadonlyArray<AppMcpQuestion> => {
	if (!Array.isArray(args.questions) || args.questions.length === 0) {
		throw new Error("questions must contain at least one question");
	}
	return args.questions.map((value) => {
		if (value === null || typeof value !== "object" || Array.isArray(value)) {
			throw new Error("question must be an object");
		}
		const record = value as Record<string, unknown>;
		if (
			typeof record.question !== "string" ||
			!Array.isArray(record.options) ||
			!record.options.every((option) => typeof option === "string")
		) {
			throw new Error("question and string options are required");
		}
		return {
			question: record.question,
			options: record.options,
			...(typeof record.multiSelect === "boolean"
				? { multiSelect: record.multiSelect }
				: {}),
		};
	});
};

const questionResult = (
	questions: ReadonlyArray<AppMcpQuestion>,
	answers: ReadonlyArray<AppMcpQuestionAnswer> | null,
) => {
	if (answers === null) {
		return {
			content: [
				{ type: "text" as const, text: "User cancelled the question." },
			],
			isError: true as const,
		};
	}
	const lines: string[] = [];
	for (const answer of answers) {
		const question = questions[answer.questionIndex];
		if (question === undefined) continue;
		const selected = answer.selected.map(
			(index) => question.options[index] ?? `#${index}`,
		);
		lines.push(
			`Q: ${question.question}\nA: ${
				selected.length > 0 ? selected.join(", ") : "(no preset)"
			}`,
		);
		if (answer.other !== undefined && answer.other.length > 0) {
			lines.push(`  (other: ${answer.other})`);
		}
	}
	return {
		content: [
			{ type: "text" as const, text: lines.join("\n\n") },
			{ type: "text" as const, text: JSON.stringify({ answers }) },
		],
	};
};

type AppToolDefinition = {
	readonly name: string;
	readonly description: string;
	readonly inputSchema: Record<string, unknown>;
};

const buildAppServer = (record: RegistryRecord): Server => {
	const definitions: AppToolDefinition[] = [
		...(record.scopes.browser && record.ctx.browser !== undefined
			? BROWSER_MCP_TOOLS
			: []),
		...(record.scopes.orchestration && record.ctx.orchestration !== undefined
			? ORCHESTRATION_MCP_TOOLS
			: []),
		...(record.scopes.linear && record.ctx.linear !== undefined
			? LINEAR_MCP_TOOLS
			: []),
		...(record.scopes.images && record.ctx.images !== undefined
			? IMAGE_MCP_TOOLS
			: []),
		...(record.scopes.interaction && record.ctx.interaction !== undefined
			? [ASK_USER_QUESTION_TOOL]
			: []),
	];
	const names = new Set<string>();
	for (const definition of definitions) {
		if (names.has(definition.name)) {
			throw new Error(`Duplicate app MCP tool: ${definition.name}`);
		}
		names.add(definition.name);
	}

	const server = new Server(
		{ name: APP_MCP_SERVER_NAME, version: "0.0.1" },
		{ capabilities: { tools: {} } },
	);
	server.setRequestHandler(ListToolsRequestSchema, async () => ({
		tools: definitions.map((definition) => ({
			name: definition.name,
			description: definition.description,
			inputSchema: definition.inputSchema,
		})),
	}));
	server.setRequestHandler(CallToolRequestSchema, async (request) => {
		const name = request.params.name;
		const args = asJsonObject(request.params.arguments ?? {});
		if (!names.has(name)) {
			return {
				content: [{ type: "text" as const, text: `Unknown tool: ${name}` }],
				isError: true,
			};
		}
		try {
			if (BROWSER_MCP_TOOLS.some((tool) => tool.name === name)) {
				if (record.ctx.browser === undefined)
					throw new Error("Browser unavailable");
				return await handleBrowserTool(name, args, record.ctx.browser);
			}
			if (isOrchestrationToolName(name)) {
				if (record.ctx.orchestration === undefined) {
					throw new Error("Orchestration unavailable");
				}
				await ensureOrchestrationPermission(
					name,
					args,
					record.ctx.orchestration,
				);
				return await callOrchestrationTool(
					record.ctx.orchestration.deps,
					name,
					args,
				);
			}
			if (isLinearToolName(name)) {
				if (record.ctx.linear === undefined)
					throw new Error("Connector unavailable");
				await ensureLinearToolPermission(name, args, record.ctx.linear);
				return await callLinearTool(record.ctx.linear.deps, name, args);
			}
			if (IMAGE_MCP_TOOLS.some((tool) => tool.name === name)) {
				if (record.ctx.images === undefined)
					throw new Error("Images unavailable");
				return await handleImageTool(name, args, record.ctx.images);
			}
			if (name === ASK_USER_QUESTION_TOOL.name) {
				if (record.ctx.interaction === undefined) {
					throw new Error("User interaction unavailable");
				}
				const questions = parseQuestions(args);
				return questionResult(
					questions,
					await record.ctx.interaction.askUserQuestion(questions),
				);
			}
			throw new Error(`Unknown tool: ${name}`);
		} catch (cause) {
			return toolResultFromError(name, cause);
		}
	});
	return server;
};

const handleMcpRequest = async (
	req: IncomingMessage,
	res: ServerResponse,
	record: RegistryRecord,
): Promise<void> => {
	const mcpServer = buildAppServer(record);
	const transport = new StreamableHTTPServerTransport({
		sessionIdGenerator: undefined,
	});
	res.once("close", () => {
		void transport.close();
		void mcpServer.close();
	});
	await mcpServer.connect(transport);
	await transport.handleRequest(req, res);
};

const requestHandler = (req: IncomingMessage, res: ServerResponse): void => {
	void (async () => {
		const path = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
		if (path !== APP_MCP_PATH) {
			writeText(res, 404, "not found");
			return;
		}
		const token = parseMcpBearerAuthorization(req.headers.authorization);
		if (token === null) {
			unauthorized(res);
			return;
		}
		const record = resolveRecord(token);
		if (record === null) {
			unauthorized(res);
			return;
		}
		try {
			await handleMcpRequest(req, res, record);
		} catch (cause) {
			if (!res.headersSent) {
				res.writeHead(500, { "content-type": "application/json" });
				res.end(
					JSON.stringify({
						jsonrpc: "2.0",
						error: {
							code: -32603,
							message: cause instanceof Error ? cause.message : String(cause),
						},
						id: null,
					}),
				);
			}
		}
	})();
};

const ensureServer = async (): Promise<{
	readonly server: HttpServer;
	readonly port: number;
}> => {
	if (serverPromise !== null) return serverPromise;
	serverPromise = new Promise((resolve, reject) => {
		const server = createServer(requestHandler);
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			server.off("error", reject);
			const address = server.address();
			if (address === null || typeof address === "string") {
				reject(new Error("Could not bind MCP gateway."));
				return;
			}
			console.info(`[mcp-gateway] listening on 127.0.0.1:${address.port}`);
			resolve({ server, port: address.port });
		});
	});
	return serverPromise;
};

export const issueMcpGatewaySession = async (
	input: McpGatewayIssueInput,
): Promise<McpGatewaySession> => {
	const { port } = await ensureServer();
	await revokeMcpGatewaySession(input.sessionId);
	const token = randomBytes(32).toString("base64url");
	const hash = tokenHash(token);
	const now = Date.now();
	const record: RegistryRecord = {
		sessionId: input.sessionId,
		tokenHash: hash,
		issuedAt: now,
		expiresAt: now + MAX_LIFETIME_MS,
		scopes: input.scopes,
		ctx: input.ctx,
		lastUsedAt: now,
	};
	recordsBySession.set(input.sessionId, record);
	recordsByHash.set(hash, record);
	const endpoint = `http://127.0.0.1:${port}${APP_MCP_PATH}`;
	const authorizationHeader = `Bearer ${token}`;
	return {
		token,
		endpoint,
		serverConfig: {
			type: "http",
			name: APP_MCP_SERVER_NAME,
			url: endpoint,
			headers: [{ name: "Authorization", value: authorizationHeader }],
		},
		codexServerConfig: {
			url: endpoint,
			bearer_token_env_var: "ZUSE_MCP_TOKEN",
			enabled: true,
		},
		close: () => revokeMcpGatewaySession(input.sessionId),
	};
};

export const revokeMcpGatewaySession = async (
	sessionId: string,
): Promise<void> => {
	const record = recordsBySession.get(sessionId);
	if (record === undefined) return;
	recordsBySession.delete(sessionId);
	recordsByHash.delete(record.tokenHash);
};

export const revokeAllMcpGatewaySessions = async (): Promise<void> => {
	recordsBySession.clear();
	recordsByHash.clear();
};

export const mcpGatewayDiagnostics = (): {
	readonly activeSessionCount: number;
} => {
	pruneExpired();
	return { activeSessionCount: recordsBySession.size };
};

export const __testing = {
	parseMcpBearerAuthorization,
	pruneExpired,
	resolveRecord,
	closeServer: async () => {
		const current = serverPromise;
		serverPromise = null;
		recordsBySession.clear();
		recordsByHash.clear();
		if (current === null) return;
		const { server } = await current;
		await new Promise<void>((resolve) => {
			server.close(() => resolve());
		});
	},
};
