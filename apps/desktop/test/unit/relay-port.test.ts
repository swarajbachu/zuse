import * as net from "node:net";
import { afterEach, describe, expect, it } from "vitest";

import { resolveDesktopRelayPort } from "../../src/relay-port.ts";

const servers: net.Server[] = [];

const listen = (port: number): Promise<net.Server> =>
	new Promise((resolve, reject) => {
		const server = net.createServer();
		server.once("error", reject);
		server.listen(port, "127.0.0.1", () => {
			servers.push(server);
			resolve(server);
		});
	});

afterEach(async () => {
	await Promise.all(
		servers
			.splice(0)
			.map(
				(server) =>
					new Promise<void>((resolve) => server.close(() => resolve())),
			),
	);
});

describe("resolveDesktopRelayPort", () => {
	it("moves the default relay listener when its conventional port is occupied", async () => {
		const occupied = await listen(0);
		const address = occupied.address();
		expect(address).not.toBeNull();
		expect(typeof address).not.toBe("string");
		const preferredPort = (address as net.AddressInfo).port;

		const resolved = await resolveDesktopRelayPort({
			configuredPort: undefined,
			defaultPort: preferredPort,
		});

		expect(resolved.port).not.toBe(preferredPort);
		expect(resolved.fellBack).toBe(true);
	});

	it("keeps an explicit relay port unchanged", async () => {
		await expect(
			resolveDesktopRelayPort({ configuredPort: "0" }),
		).resolves.toEqual({ port: 0, fellBack: false });
	});
});
