import { createServer } from "node:http";
import { createServer as createTcpServer, type Socket } from "node:net";
import type { TailnetCommandResult } from "@zuse/tailnet";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import {
	makePreviewService,
	probeLoopbackHttp,
} from "../../src/preview/preview-service.ts";

const commandResult = (
	stdout = "",
	code = 0,
	stderr = "",
): TailnetCommandResult => ({ stdout, stderr, code });

const runningStatus = JSON.stringify({
	BackendState: "Running",
	Self: { DNSName: "Build-Box.Example.ts.net." },
});

describe("preview service", () => {
	it("detects HTTP without waiting for an application route", async () => {
		const server = createServer((request, response) => {
			if (request.method === "OPTIONS" && request.url === "*") {
				response.writeHead(204);
				response.end();
			}
		});
		await new Promise<void>((resolve) =>
			server.listen(0, "127.0.0.1", resolve),
		);
		const address = server.address();
		if (address === null || typeof address === "string") {
			throw new Error("Test server did not bind a TCP port");
		}

		try {
			const startedAt = performance.now();
			await expect(probeLoopbackHttp(address.port)).resolves.toBe(true);
			expect(performance.now() - startedAt).toBeLessThan(1_000);
		} finally {
			server.closeAllConnections();
			await new Promise<void>((resolve, reject) =>
				server.close((error) =>
					error === undefined ? resolve() : reject(error),
				),
			);
		}
	});

	it("does not expose a non-HTTP listener as a preview", async () => {
		const connections = new Set<Socket>();
		const server = createTcpServer((socket) => {
			connections.add(socket);
			socket.once("close", () => connections.delete(socket));
			socket.end("NOT-HTTP\n");
		});
		await new Promise<void>((resolve) =>
			server.listen(0, "127.0.0.1", resolve),
		);
		const address = server.address();
		if (address === null || typeof address === "string") {
			throw new Error("Test server did not bind a TCP port");
		}

		try {
			await expect(probeLoopbackHttp(address.port)).resolves.toBe(false);
		} finally {
			for (const connection of connections) connection.destroy();
			await new Promise<void>((resolve, reject) =>
				server.close((error) =>
					error === undefined ? resolve() : reject(error),
				),
			);
		}
	});

	it("lists only loopback HTTP servers and hides the Zuse control port", async () => {
		const service = makePreviewService({
			listListeners: async () => [
				{ name: "node", port: 3001 },
				{ name: "postgres", port: 5432 },
				{ name: "zuse", port: 47837 },
			],
			probeHttp: async (port) => port === 3001,
			runTailnet: async () => commandResult(),
			zusePort: 47837,
		});

		await expect(Effect.runPromise(service.listServers())).resolves.toEqual([
			{ name: "node", port: 3001 },
		]);
	});

	it("creates a private HTTPS route for a running dev server", async () => {
		const calls: ReadonlyArray<string>[] = [];
		const service = makePreviewService({
			listListeners: async () => [{ name: "node", port: 3001 }],
			probeHttp: async () => true,
			runTailnet: async (args) => {
				calls.push(args);
				return args[0] === "status"
					? commandResult(runningStatus)
					: commandResult();
			},
			zusePort: 47837,
		});

		await expect(Effect.runPromise(service.forward(3001))).resolves.toEqual({
			port: 3001,
			url: "https://build-box.example.ts.net:3001",
			transport: "private-network",
		});
		expect(calls).toEqual([
			["status", "--json"],
			["serve", "--bg", "--yes", "--https=3001", "http://127.0.0.1:3001"],
		]);
	});

	it("rejects missing and non-HTTP listeners before changing networking", async () => {
		let commands = 0;
		const service = makePreviewService({
			listListeners: async () => [{ name: "postgres", port: 5432 }],
			probeHttp: async () => false,
			runTailnet: async () => {
				commands += 1;
				return commandResult();
			},
			zusePort: 47837,
		});

		await expect(
			Effect.runPromise(service.forward(3001)),
		).rejects.toMatchObject({
			code: "server-not-found",
		});
		await expect(
			Effect.runPromise(service.forward(5432)),
		).rejects.toMatchObject({
			code: "server-not-http",
		});
		expect(commands).toBe(0);
	});

	it("returns a stable setup error when private networking is unavailable", async () => {
		const service = makePreviewService({
			listListeners: async () => [{ name: "node", port: 3001 }],
			probeHttp: async () => true,
			runTailnet: async () => commandResult("", 1, "not logged in"),
			zusePort: 47837,
		});

		await expect(
			Effect.runPromise(service.forward(3001)),
		).rejects.toMatchObject({
			code: "private-network-required",
		});
	});

	it("surfaces feature approval without exposing command output", async () => {
		const approvalUrl = "https://login.tailscale.com/f/serve?node=example";
		const service = makePreviewService({
			listListeners: async () => [{ name: "node", port: 3001 }],
			probeHttp: async () => true,
			runTailnet: async (args) =>
				args[0] === "status"
					? commandResult(runningStatus)
					: { ...commandResult("private-output"), approvalUrl },
			zusePort: 47837,
		});

		await expect(
			Effect.runPromise(service.forward(3001)),
		).rejects.toMatchObject({
			code: "private-preview-approval-required",
			approvalUrl,
		});
	});
});
