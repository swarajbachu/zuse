import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { basename, sep } from "node:path";
import { fileURLToPath } from "node:url";

import type { PermissionDecision, PermissionKind, PermissionMode, RuntimeMode } from "@zuse/wire";

import {
  callOrchestrationTool,
  ensureOrchestrationPermission,
  isOrchestrationToolName,
  ORCHESTRATION_MCP_SERVER_NAME,
  ORCHESTRATION_MCP_TOOLS,
  type OrchestrationMcpToolResult,
  type OrchestrationToolDeps,
} from "../orchestration-tools.ts";

type JsonObject = Record<string, unknown>;

const text = (value: string, isError = false): OrchestrationMcpToolResult => ({
  content: [{ type: "text", text: value }],
  ...(isError ? { isError: true } : {}),
});

const asString = (args: JsonObject, key: string, required = false): string | undefined => {
  const value = args[key];
  if (typeof value === "string" && value.length > 0) return value;
  if (required) throw new Error(`Missing ${key}.`);
  return undefined;
};

const readBody = async (req: import("node:http").IncomingMessage) =>
  new Promise<string>((resolve, reject) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 1_000_000) {
        reject(new Error("request too large"));
        req.destroy();
      }
    });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });

export interface OrchestrationMcpBridgeOptions {
  readonly deps: OrchestrationToolDeps;
  readonly command: string;
  readonly requestPermission: (
    kind: PermissionKind,
    options: { readonly forcePrompt: boolean },
  ) => Promise<PermissionDecision>;
  readonly getRuntimeMode: () => RuntimeMode;
  readonly getPermissionMode: () => PermissionMode;
}

const handleOrchestrationTool = async (
  name: string,
  args: JsonObject,
  opts: OrchestrationMcpBridgeOptions,
): Promise<OrchestrationMcpToolResult> => {
  if (!isOrchestrationToolName(name)) throw new Error(`Unknown tool: ${name}`);
  await ensureOrchestrationPermission(name, args, opts);
  return callOrchestrationTool(opts.deps, name, args);
};

export interface OrchestrationMcpBridge {
  readonly serverConfig: {
    readonly name: string;
    readonly command: string;
    readonly args: ReadonlyArray<string>;
    readonly env: ReadonlyArray<{
      readonly name: string;
      readonly value: string;
    }>;
  };
  readonly projectConfigToml: string;
  readonly close: () => Promise<void>;
}

const resolveChildScript = (): string => {
  const bundled = fileURLToPath(
    new URL("./orchestration-mcp-child.cjs", import.meta.url),
  );
  const unpacked = bundled.replace(
    `${sep}app.asar${sep}`,
    `${sep}app.asar.unpacked${sep}`,
  );
  if (existsSync(unpacked)) return unpacked;
  if (existsSync(bundled)) return bundled;
  const source = fileURLToPath(
    new URL("./orchestration-mcp-child.ts", import.meta.url),
  );
  if (!existsSync(source)) {
    console.error(
      `[zuse-orchestration-mcp] child script missing — looked for ${unpacked}, ${bundled}, ${source}.`,
    );
  }
  return source;
};

export const startOrchestrationMcpBridge = async (
  opts: OrchestrationMcpBridgeOptions,
): Promise<OrchestrationMcpBridge> => {
  const token = randomBytes(24).toString("hex");
  const server: Server = createServer(async (req, res) => {
    try {
      if (req.method !== "POST" || req.url !== "/tool") {
        res.writeHead(404).end("not found");
        return;
      }
      if (req.headers.authorization !== `Bearer ${token}`) {
        res.writeHead(401).end("unauthorized");
        return;
      }
      const body = JSON.parse(await readBody(req)) as unknown;
      if (body === null || typeof body !== "object") {
        throw new Error("Expected JSON object.");
      }
      const payload = body as JsonObject;
      const name = asString(payload, "name", true)!;
      const rawArgs = payload["arguments"];
      const args =
        rawArgs !== null &&
        typeof rawArgs === "object" &&
        !Array.isArray(rawArgs)
          ? (rawArgs as JsonObject)
          : {};
      const result = await handleOrchestrationTool(name, args, opts);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(result));
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(text(message, true)));
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("Could not bind orchestration MCP bridge.");
  }

  const childPath = resolveChildScript();
  const command = basename(opts.command).includes("bun")
    ? opts.command
    : process.execPath;
  const envToml = `ZUSE_ORCHESTRATION_MCP_URL = "http://127.0.0.1:${address.port}", ZUSE_ORCHESTRATION_MCP_TOKEN = "${token}"`;
  const argsToml = JSON.stringify([childPath]);
  console.info(
    `[zuse-orchestration-mcp] listening on 127.0.0.1:${address.port}; command=${command}; child=${childPath}`,
  );

  return {
    serverConfig: {
      name: ORCHESTRATION_MCP_SERVER_NAME,
      command,
      args: [childPath],
      env: [
        {
          name: "ZUSE_ORCHESTRATION_MCP_URL",
          value: `http://127.0.0.1:${address.port}`,
        },
        { name: "ZUSE_ORCHESTRATION_MCP_TOKEN", value: token },
      ],
    },
    projectConfigToml: [
      `[mcp_servers.${JSON.stringify(ORCHESTRATION_MCP_SERVER_NAME)}]`,
      `command = ${JSON.stringify(command)}`,
      `args = ${argsToml}`,
      `env = { ${envToml} }`,
      `enabled = true`,
      ``,
    ].join("\n"),
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
};

export const orchestrationToolNames = (): ReadonlyArray<string> =>
  ORCHESTRATION_MCP_TOOLS.map((toolDef) => toolDef.name);
