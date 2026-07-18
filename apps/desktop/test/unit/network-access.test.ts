import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
	readNetworkAccessPreference,
	resolveNetworkAccessState,
	writeNetworkAccessPreference,
} from "../../src/network-access.ts";

const interfaces = {
	en0: [
		{
			address: "192.168.1.42",
			family: "IPv4" as const,
			internal: false,
			netmask: "255.255.255.0",
			cidr: "192.168.1.42/24",
			mac: "00:00:00:00:00:00",
			scopeid: 0,
		},
	],
};

describe("desktop network access", () => {
	it("is local-only by default", () => {
		expect(
			resolveNetworkAccessState({ enabled: false, port: 47_837, interfaces }),
		).toEqual({
			mode: "local-only",
			bindHost: "127.0.0.1",
			advertisedHost: null,
			endpointUrl: null,
			port: 47_837,
		});
	});

	it("binds all interfaces but advertises a reachable LAN address", () => {
		expect(
			resolveNetworkAccessState({ enabled: true, port: 47_837, interfaces }),
		).toEqual({
			mode: "network-accessible",
			bindHost: "0.0.0.0",
			advertisedHost: "192.168.1.42",
			endpointUrl: "ws://192.168.1.42:47837",
			port: 47_837,
		});
	});

	it("prefers a stable local hostname across Wi-Fi address changes", () => {
		expect(
			resolveNetworkAccessState({
				enabled: true,
				port: 47_837,
				interfaces,
				stableHost: "MacBook-Pro.local",
			}),
		).toMatchObject({
			advertisedHost: "MacBook-Pro.local",
			endpointUrl: "ws://MacBook-Pro.local:47837",
		});
	});

	it("rejects enabling when no reachable address exists", () => {
		expect(() =>
			resolveNetworkAccessState({
				enabled: true,
				port: 47_837,
				interfaces: {
					lo0: [
						{
							address: "127.0.0.1",
							family: "IPv4",
							internal: true,
							netmask: "255.0.0.0",
							cidr: "127.0.0.1/8",
							mac: "00:00:00:00:00:00",
							scopeid: 0,
						},
					],
				},
			}),
		).toThrow("No reachable local network address is available");
	});

	it("persists the preference atomically", async () => {
		const userData = await mkdtemp(join(tmpdir(), "zuse-network-access-"));
		await writeNetworkAccessPreference(userData, true);

		await expect(readNetworkAccessPreference(userData)).resolves.toBe(true);
		await expect(
			readFile(join(userData, "network-access.json"), "utf8"),
		).resolves.toContain('"enabled": true');
	});
});
