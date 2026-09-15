import { spawn } from "node:child_process";
import { once } from "node:events";
import { createConnection, createServer } from "node:net";
import { networkInterfaces } from "node:os";
import { expect, test } from "vitest";
import { BOX_PORT_FORWARDER } from "../../src/box-port-forwarder.ts";

const address = Object.values(networkInterfaces())
	.flat()
	.find((entry) => entry?.family === "IPv4" && !entry.internal)?.address;

test.skipIf(address === undefined)(
	"forwards loopback data and half-closes without dropping buffered bytes",
	async () => {
		const payload = Buffer.alloc(256 * 1024, 42);
		const server = createServer({ allowHalfOpen: true }, (socket) => {
			const chunks: Buffer[] = [];
			socket.on("data", (data: Buffer) => chunks.push(data));
			socket.on("end", () => socket.end(Buffer.concat(chunks)));
		});
		server.listen(0, "127.0.0.1");
		await once(server, "listening");
		const bound = server.address();
		if (bound === null || typeof bound === "string")
			throw new Error("missing port");
		const child = spawn(
			process.execPath,
			["-e", BOX_PORT_FORWARDER, String(bound.port), "daemon"],
			{
				stdio: ["ignore", "ignore", "pipe", "ipc"],
			},
		);
		let socket: ReturnType<typeof createConnection> | undefined;
		try {
			expect(await once(child, "message")).toEqual(["ready", undefined]);
			socket = createConnection({ host: address, port: bound.port });
			await once(socket, "connect");
			const chunks: Buffer[] = [];
			socket.on("data", (data: Buffer) => chunks.push(data));
			const ended = once(socket, "end");
			socket.end(payload);
			await ended;
			expect(Buffer.concat(chunks)).toEqual(payload);
			// Resolving an already-hosted endpoint must not replace its listeners.
			const repeated = spawn(
				process.execPath,
				["-e", BOX_PORT_FORWARDER, String(bound.port)],
				{ stdio: "ignore" },
			);
			expect((await once(repeated, "exit"))[0]).toBe(0);
		} finally {
			socket?.destroy();
			child.kill();
			await once(child, "exit");
			await new Promise<void>((resolve) => server.close(() => resolve()));
		}
	},
	15000,
);
