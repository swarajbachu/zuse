import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { basename, sep } from "node:path";
import { fileURLToPath } from "node:url";

import type {
  PermissionDecision,
  PermissionKind,
  PermissionMode,
  RuntimeMode,
} from "@zuse/contracts";

import {
  BROWSER_MCP_SERVER_NAME,
  handleBrowserTool,
  type BrowserMcpToolResult,
} from "../browser-mcp-tools.ts";
import type { BrowserSend } from "../browser-tools.ts";

export { browserMcpPromptHint } from "../browser-mcp-tools.ts";

type JsonObject = Record<string, unknown>;

const text = (value: string, isError = false): BrowserMcpToolResult => ({
  content: [{ type: "text", text: value }],
  ...(isError ? { isError: true } : {}),
});

const asString = (
  args: JsonObject,
  key: string,
  required = false,
): string | undefined => {
  const value = args[key];
  if (typeof value === "string" && value.length > 0) return value;
  if (required) throw new Error(`Missing ${key}.`);
  return undefined;
};

export interface BrowserMcpBridgeOptions {
  readonly send: BrowserSend;
  readonly command: string;
  readonly requestPermission: (
    kind: PermissionKind,
    options: { readonly forcePrompt: boolean },
  ) => Promise<PermissionDecision>;
  readonly getRuntimeMode: () => RuntimeMode;
  readonly getPermissionMode: () => PermissionMode;
}

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

export interface BrowserMcpBridge {
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

/**
 * Locate the stdio MCP child script the ACP provider will spawn. This module
 * gets bundled into `dist-electron/main.cjs` by tsdown, so `import.meta.url`
 * points at the bundle directory, NOT the source tree — a bare
 * `./browser-mcp-child.ts` sibling lookup resolves to a file that was never
 * emitted and the child dies at spawn ("Transport channel closed", every
 * tool call "Tool not found"). Resolution order:
 *
 *   1. `browser-mcp-child.cjs` next to the bundle (built by the dedicated
 *      tsdown entry), remapped out of the asar in packaged builds — bun is
 *      an external process and cannot read inside `app.asar`.
 *   2. The `.ts` source sibling — running unbundled from source (headless
 *      server under bun, tests), where bun executes TypeScript directly.
 */
const resolveChildScript = (): string => {
  const bundled = fileURLToPath(
    new URL("./browser-mcp-child.cjs", import.meta.url),
  );
  const unpacked = bundled.replace(
    `${sep}app.asar${sep}`,
    `${sep}app.asar.unpacked${sep}`,
  );
  if (existsSync(unpacked)) return unpacked;
  if (existsSync(bundled)) return bundled;
  const source = fileURLToPath(
    new URL("./browser-mcp-child.ts", import.meta.url),
  );
  if (!existsSync(source)) {
    // Don't fail the whole agent session over browser tools, but be loud:
    // this exact silent failure already shipped once.
    console.error(
      `[grok.browser-mcp] child script missing — looked for ${unpacked}, ${bundled}, ${source}. ` +
        "Browser tools will be unavailable to this ACP session (did the desktop build emit browser-mcp-child.cjs?).",
    );
  }
  return source;
};

export const startBrowserMcpBridge = async (
  opts: BrowserMcpBridgeOptions,
): Promise<BrowserMcpBridge> => {
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
      const result = await handleBrowserTool(name, args, opts);
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
    throw new Error("Could not bind browser MCP bridge.");
  }

  const childPath = resolveChildScript();
  const command = basename(opts.command).includes("bun")
    ? opts.command
    : process.execPath;
  const envToml = `ZUSE_BROWSER_MCP_URL = "http://127.0.0.1:${address.port}", ZUSE_BROWSER_MCP_TOKEN = "${token}"`;
  const argsToml = JSON.stringify([childPath]);
  console.info(
    `[grok.browser-mcp] listening on 127.0.0.1:${address.port}; command=${command}; child=${childPath}`,
  );

  return {
    serverConfig: {
      name: BROWSER_MCP_SERVER_NAME,
      command,
      args: [childPath],
      env: [
        {
          name: "ZUSE_BROWSER_MCP_URL",
          value: `http://127.0.0.1:${address.port}`,
        },
        { name: "ZUSE_BROWSER_MCP_TOKEN", value: token },
      ],
    },
    projectConfigToml: [
      `[mcp_servers.${JSON.stringify(BROWSER_MCP_SERVER_NAME)}]`,
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
