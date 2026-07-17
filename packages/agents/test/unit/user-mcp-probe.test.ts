import * as http from "node:http";
import type { AddressInfo } from "node:net";
import * as Path from "node:path";
import { Effect } from "effect";
import { afterAll, describe, expect, it } from "vitest";

import { probeMcpServer } from "../../src/user-mcp/probe.ts";

const FIXTURE = Path.join(
	import.meta.dirname,
	"..",
	"fixtures",
	"stdio-mcp-server.mjs",
);

const servers: http.Server[] = [];

const listen = (
	handler: http.RequestListener,
): Promise<{ url: string; close: () => void }> =>
	new Promise((resolve) => {
		const server = http.createServer(handler);
		servers.push(server);
		server.listen(0, "127.0.0.1", () => {
			const { port } = server.address() as AddressInfo;
			resolve({
				url: `http://127.0.0.1:${port}/mcp`,
				close: () => server.close(),
			});
		});
	});

afterAll(() => {
	for (const server of servers) server.close();
});

describe("probeMcpServer classification", () => {
	it("connects to a real stdio server and lists its tools", async () => {
		const result = await Effect.runPromise(
			probeMcpServer(
				{
					transport: "stdio",
					name: "fixture",
					command: process.execPath,
					args: [FIXTURE],
				},
				10_000,
			),
		);
		expect(result.state).toBe("connected");
		expect([...result.toolNames].sort()).toEqual(["echo", "ping"]);
	});

	it("reports a missing stdio command as 'command not found'", async () => {
		const result = await Effect.runPromise(
			probeMcpServer(
				{
					transport: "stdio",
					name: "ghost",
					command: "definitely-not-a-real-command-zx9",
					args: [],
				},
				5_000,
			),
		);
		expect(result.state).toBe("error");
		expect(result.error).toContain("command not found");
	});

	it("reports an http 401 as needs-auth (oauth)", async () => {
		const fixture = await listen((_req, res) => {
			res.writeHead(401, {
				"www-authenticate": 'Bearer resource_metadata="https://x/meta"',
			});
			res.end();
		});
		const result = await Effect.runPromise(
			probeMcpServer(
				{ transport: "http", name: "authy", url: fixture.url },
				5_000,
			),
		);
		fixture.close();
		expect(result.state).toBe("needs-auth");
		expect(result.authMethod).toBe("oauth");
	});

	it("reports a refused connection as an error", async () => {
		// Grab a free port, then close it so nothing is listening.
		const fixture = await listen((_req, res) => res.end());
		fixture.close();
		await new Promise((resolve) => setTimeout(resolve, 20));
		const result = await Effect.runPromise(
			probeMcpServer(
				{ transport: "http", name: "gone", url: fixture.url },
				5_000,
			),
		);
		expect(result.state).toBe("error");
		expect(result.error).toBeTruthy();
	});
});
