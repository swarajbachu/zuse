import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const servers: Array<ReturnType<typeof createServer>> = [];
const sockets = new Set<Socket>();

afterEach(async () => {
	for (const socket of sockets) socket.destroy();
	sockets.clear();
	await Promise.all(
		servers
			.splice(0)
			.map((server) => new Promise<void>((done) => server.close(() => done()))),
	);
});

const listen = async (
	server: ReturnType<typeof createServer>,
): Promise<number> =>
	new Promise((resolvePort) => {
		server.listen(0, "127.0.0.1", () => {
			const address = server.address();
			if (address === null || typeof address === "string")
				throw new Error("bind");
			resolvePort(address.port);
		});
	});

const runBridge = async (port: number, timeoutMs: number) => {
	const home = await mkdtemp(join(tmpdir(), "zuse-bridge-child-"));
	const tickets = join(home, ".zuse", "ssh", "tickets");
	await mkdir(tickets, { recursive: true });
	await writeFile(
		join(tickets, "workspace_a.json"),
		JSON.stringify({
			wsUrl: `ws://127.0.0.1:${port}/ssh`,
			ticket: "private-ticket",
			expiresAt: Date.now() + 60_000,
		}),
	);
	return new Promise<{ code: number | null; stderr: string }>(
		(done, reject) => {
			const child = spawn(
				process.execPath,
				[
					"--import",
					"tsx",
					fileURLToPath(
						new URL("../../src/ssh/ssh-bridge-child.ts", import.meta.url),
					),
					"zuse-workspace_a",
				],
				{
					env: {
						...process.env,
						HOME: home,
						ZUSE_SSH_BRIDGE_CONNECT_TIMEOUT_MS: String(timeoutMs),
					},
					stdio: ["pipe", "ignore", "pipe"],
				},
			);
			let stderr = "";
			child.stderr.on("data", (chunk: Buffer) => {
				stderr += chunk.toString();
			});
			child.once("error", reject);
			child.once("close", (code) => done({ code, stderr }));
		},
	);
};

describe("ssh bridge child", () => {
	it("times out a connection that never completes its WebSocket handshake", async () => {
		const server = createServer();
		servers.push(server);
		server.on("connection", (socket) => {
			sockets.add(socket);
			socket.once("close", () => sockets.delete(socket));
		});
		server.on("upgrade", () => undefined);
		const result = await runBridge(await listen(server), 50);
		expect(result.code).toBe(1);
		expect(result.stderr).toContain("connection timed out");
		expect(result.stderr).not.toContain("private-ticket");
	});

	it("returns a nonzero exit for an abnormal WebSocket close", async () => {
		const server = createServer();
		servers.push(server);
		server.on("connection", (socket) => {
			sockets.add(socket);
			socket.once("close", () => sockets.delete(socket));
		});
		server.on("upgrade", (request, socket) => {
			const key = request.headers["sec-websocket-key"];
			if (typeof key !== "string") return socket.destroy();
			const accept = createHash("sha1")
				.update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
				.digest("base64");
			socket.write(
				`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
			);
			socket.write(Buffer.from([0x88, 0x02, 0x03, 0xf3]));
			setTimeout(() => socket.end(), 10);
		});
		const result = await runBridge(await listen(server), 1_000);
		expect(result.code).toBe(1);
		expect(result.stderr).toContain("1011");
	});

	it("diagnoses a missing sandbox without exposing its ticket", async () => {
		const server = createServer((_request, response) => {
			response.writeHead(502, { "content-type": "application/json" });
			response.end('{"message":"The sandbox was not found"}');
		});
		servers.push(server);
		server.on("connection", (socket) => {
			sockets.add(socket);
			socket.once("close", () => sockets.delete(socket));
		});
		server.on("upgrade", (_request, socket) => {
			socket.end(
				'HTTP/1.1 502 Bad Gateway\r\nContent-Type: application/json\r\nContent-Length: 43\r\n\r\n{"message":"The sandbox was not found"}',
			);
		});
		const result = await runBridge(await listen(server), 1_000);
		expect(result.code).toBe(1);
		expect(result.stderr).toContain("workspace is not running");
		expect(result.stderr).not.toContain("private-ticket");
	});
});
