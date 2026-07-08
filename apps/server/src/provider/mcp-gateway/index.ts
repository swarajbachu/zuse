import {
  createHash,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type Server as HttpServer,
  type ServerResponse,
} from "node:http";

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

import {
  BROWSER_MCP_SERVER_NAME,
  BROWSER_MCP_TOOLS,
  handleBrowserTool,
  type BrowserMcpToolOptions,
} from "../drivers/browser-mcp-tools.ts";
import {
  callOrchestrationTool,
  ensureOrchestrationPermission,
  isOrchestrationToolName,
  ORCHESTRATION_MCP_SERVER_NAME,
  ORCHESTRATION_MCP_TOOLS,
  type OrchestrationPermissionOptions,
  type OrchestrationToolDeps,
} from "../drivers/orchestration-tools.ts";

type JsonObject = Record<string, unknown>;

const IDLE_TIMEOUT_MS = 30 * 60 * 1_000;
const MAX_LIFETIME_MS = 8 * 60 * 60 * 1_000;

const BROWSER_PATH = `/mcp/${BROWSER_MCP_SERVER_NAME}`;
const ORCHESTRATION_PATH = `/mcp/${ORCHESTRATION_MCP_SERVER_NAME}`;

export interface McpGatewaySessionContext {
  readonly browser?: BrowserMcpToolOptions;
  readonly orchestration?: OrchestrationPermissionOptions & {
    readonly deps: OrchestrationToolDeps;
  };
}

export interface McpGatewayIssueInput {
  readonly sessionId: string;
  readonly scopes: {
    readonly browser: boolean;
    readonly orchestration: boolean;
  };
  readonly ctx: McpGatewaySessionContext;
}

export interface McpGatewaySession {
  readonly token: string;
  readonly endpoints: {
    readonly browser: string;
    readonly orchestration: string;
  };
  readonly httpServerConfigs: {
    readonly browser: AcpHttpMcpServerConfig;
    readonly orchestration: AcpHttpMcpServerConfig;
  };
  readonly codexServerConfigs: {
    readonly browser: CodexHttpMcpServerConfig;
    readonly orchestration: CodexHttpMcpServerConfig;
  };
  readonly close: () => Promise<void>;
}

export interface AcpHttpMcpServerConfig {
  readonly type: "http";
  readonly name: string;
  readonly url: string;
  readonly headers: ReadonlyArray<{ readonly name: string; readonly value: string }>;
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
  };
  readonly ctx: McpGatewaySessionContext;
  readonly lastUsedAt: number;
}

let serverPromise: Promise<{ readonly server: HttpServer; readonly port: number }> | null =
  null;
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
  return match ? match[1]! : null;
};

const pruneExpired = (now = Date.now()): void => {
  for (const record of recordsBySession.values()) {
    if (
      now > record.expiresAt ||
      now - record.lastUsedAt > IDLE_TIMEOUT_MS
    ) {
      recordsBySession.delete(record.sessionId);
      recordsByHash.delete(record.tokenHash);
    }
  }
};

const resolveRecord = (
  rawToken: string,
  scope: "browser" | "orchestration",
): RegistryRecord | null => {
  pruneExpired();
  const hash = tokenHash(rawToken);
  const record = recordsByHash.get(hash);
  if (record === undefined || !constantTimeEqual(hash, record.tokenHash)) {
    return null;
  }
  if (!record.scopes[scope]) return null;
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

const buildBrowserServer = (ctx: BrowserMcpToolOptions): Server => {
  const server = new Server(
    { name: BROWSER_MCP_SERVER_NAME, version: "0.0.1" },
    { capabilities: { tools: {} } },
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: BROWSER_MCP_TOOLS.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
    })),
  }));
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const name = req.params.name;
    if (!BROWSER_MCP_TOOLS.some((tool) => tool.name === name)) {
      return {
        content: [{ type: "text" as const, text: `Unknown tool: ${name}` }],
        isError: true,
      };
    }
    try {
      return await handleBrowserTool(
        name,
        asJsonObject(req.params.arguments ?? {}),
        ctx,
      );
    } catch (cause) {
      return toolResultFromError(name, cause);
    }
  });
  return server;
};

const buildOrchestrationServer = (
  ctx: OrchestrationPermissionOptions & { readonly deps: OrchestrationToolDeps },
): Server => {
  const server = new Server(
    { name: ORCHESTRATION_MCP_SERVER_NAME, version: "0.0.1" },
    { capabilities: { tools: {} } },
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: ORCHESTRATION_MCP_TOOLS.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
    })),
  }));
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const name = req.params.name;
    if (!isOrchestrationToolName(name)) {
      return {
        content: [{ type: "text" as const, text: `Unknown tool: ${name}` }],
        isError: true,
      };
    }
    const args = asJsonObject(req.params.arguments ?? {});
    try {
      await ensureOrchestrationPermission(name, args, ctx);
      return await callOrchestrationTool(ctx.deps, name, args);
    } catch (cause) {
      return toolResultFromError(name, cause);
    }
  });
  return server;
};

const handleMcpRequest = async (
  req: IncomingMessage,
  res: ServerResponse,
  scope: "browser" | "orchestration",
  record: RegistryRecord,
): Promise<void> => {
  const mcpServer =
    scope === "browser"
      ? record.ctx.browser === undefined
        ? null
        : buildBrowserServer(record.ctx.browser)
      : record.ctx.orchestration === undefined
        ? null
        : buildOrchestrationServer(record.ctx.orchestration);
  if (mcpServer === null) {
    writeText(res, 404, "not found");
    return;
  }
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
    const scope =
      path === BROWSER_PATH
        ? "browser"
        : path === ORCHESTRATION_PATH
          ? "orchestration"
          : null;
    if (scope === null) {
      writeText(res, 404, "not found");
      return;
    }
    const token = parseMcpBearerAuthorization(req.headers.authorization);
    if (token === null) {
      unauthorized(res);
      return;
    }
    const record = resolveRecord(token, scope);
    if (record === null) {
      unauthorized(res);
      return;
    }
    try {
      await handleMcpRequest(req, res, scope, record);
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
  const browser = `http://127.0.0.1:${port}${BROWSER_PATH}`;
  const orchestration = `http://127.0.0.1:${port}${ORCHESTRATION_PATH}`;
  const authorizationHeader = `Bearer ${token}`;
  return {
    token,
    endpoints: { browser, orchestration },
    httpServerConfigs: {
      browser: {
        type: "http",
        name: BROWSER_MCP_SERVER_NAME,
        url: browser,
        headers: [{ name: "Authorization", value: authorizationHeader }],
      },
      orchestration: {
        type: "http",
        name: ORCHESTRATION_MCP_SERVER_NAME,
        url: orchestration,
        headers: [{ name: "Authorization", value: authorizationHeader }],
      },
    },
    codexServerConfigs: {
      browser: {
        url: browser,
        bearer_token_env_var: "ZUSE_MCP_TOKEN",
        enabled: true,
      },
      orchestration: {
        url: orchestration,
        bearer_token_env_var: "ZUSE_MCP_TOKEN",
        enabled: true,
      },
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
