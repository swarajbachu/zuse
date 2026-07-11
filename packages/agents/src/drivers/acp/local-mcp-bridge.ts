import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { basename, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { Option, Schema } from "effect";

type JsonObject = Record<string, unknown>;

const ToolRequest = Schema.Struct({
	name: Schema.String,
	arguments: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
});
const decodeToolRequest = Schema.decodeUnknownOption(
	Schema.fromJsonString(ToolRequest),
);

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

export interface LocalMcpBridge {
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

export interface LocalMcpBridgeOptions<Result> {
	readonly serverName: string;
	readonly command: string;
	readonly environmentPrefix: string;
	readonly bundledChildUrl: URL;
	readonly sourceChildUrl: URL;
	readonly logLabel: string;
	readonly missingChildMessage: (paths: ReadonlyArray<string>) => string;
	readonly handleTool: (name: string, args: JsonObject) => Promise<Result>;
	readonly errorResult: (message: string) => Result;
}

const resolveChildScript = <Result>(
	options: LocalMcpBridgeOptions<Result>,
): string => {
	const bundled = fileURLToPath(options.bundledChildUrl);
	const unpacked = bundled.replace(
		`${sep}app.asar${sep}`,
		`${sep}app.asar.unpacked${sep}`,
	);
	if (existsSync(unpacked)) return unpacked;
	if (existsSync(bundled)) return bundled;
	const source = fileURLToPath(options.sourceChildUrl);
	if (!existsSync(source)) {
		console.error(options.missingChildMessage([unpacked, bundled, source]));
	}
	return source;
};

export const startLocalMcpBridge = async <Result>(
	options: LocalMcpBridgeOptions<Result>,
): Promise<LocalMcpBridge> => {
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
			const request = Option.getOrThrowWith(
				decodeToolRequest(await readBody(req)),
				() => new Error("Expected a valid tool request."),
			);
			const result = await options.handleTool(
				request.name,
				request.arguments ?? {},
			);
			res.writeHead(200, { "content-type": "application/json" });
			res.end(JSON.stringify(result));
		} catch (cause) {
			const message = cause instanceof Error ? cause.message : String(cause);
			res.writeHead(200, { "content-type": "application/json" });
			res.end(JSON.stringify(options.errorResult(message)));
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
		throw new Error(`Could not bind ${options.serverName} MCP bridge.`);
	}

	const childPath = resolveChildScript(options);
	const command = basename(options.command).includes("bun")
		? options.command
		: process.execPath;
	const urlName = `${options.environmentPrefix}_URL`;
	const tokenName = `${options.environmentPrefix}_TOKEN`;
	const url = `http://127.0.0.1:${address.port}`;
	console.info(
		`[${options.logLabel}] listening on 127.0.0.1:${address.port}; command=${command}; child=${childPath}`,
	);

	return {
		serverConfig: {
			name: options.serverName,
			command,
			args: [childPath],
			env: [
				{ name: urlName, value: url },
				{ name: tokenName, value: token },
			],
		},
		projectConfigToml: [
			`[mcp_servers.${JSON.stringify(options.serverName)}]`,
			`command = ${JSON.stringify(command)}`,
			`args = ${JSON.stringify([childPath])}`,
			`env = { ${urlName} = ${JSON.stringify(url)}, ${tokenName} = ${JSON.stringify(token)} }`,
			"enabled = true",
			"",
		].join("\n"),
		close: () =>
			new Promise<void>((resolve) => {
				server.close(() => resolve());
			}),
	};
};
