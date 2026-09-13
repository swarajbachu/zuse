import { describe, expect, test } from "vitest";

import {
	availableConnections,
	connectionStorageKey,
	connectionSupports,
	decodeConnectionRecords,
	refreshConnectionDescriptor,
	replaceDiscoveredRoute,
} from "../../../src/lib/connection-records";

describe("connection record persistence", () => {
	test("migrates legacy records to explicit connection sources", () => {
		expect(
			decodeConnectionRecords([
				{
					key: "paired",
					environmentId: "env-local",
					host: "192.168.1.4",
					port: 8787,
					token: "zt_local",
					label: "Desk Mac",
					updatedAt: 1,
				},
				{
					key: "api",
					environmentId: "env-remote",
					host: "api.example",
					port: 443,
					wsBaseUrl: "wss://api.example",
					token: "api-token",
					label: "Remote Mac",
					updatedAt: 2,
				},
				{
					key: "manual",
					host: "127.0.0.1",
					port: 8787,
					label: "Local server",
					updatedAt: 3,
				},
			]),
		).toMatchObject([
			{ key: "paired", source: "paired" },
			{ key: "api", source: "api" },
			{ key: "manual", source: "manual" },
		]);
	});

	test("preserves explicit sources", () => {
		const [record] = decodeConnectionRecords([
			{
				key: "manual-protected",
				host: "server.local",
				port: 8787,
				token: "custom-token",
				label: "Server",
				updatedAt: 4,
				source: "manual",
			},
		]);

		expect(record?.source).toBe("manual");
	});

	test("migrates persisted Relay connections to the API source", () => {
		const [record] = decodeConnectionRecords([
			{
				key: "relay:env_legacy",
				environmentId: "env_legacy",
				host: "api.zuse.sh",
				port: 443,
				label: "Legacy cloud connection",
				updatedAt: 1,
				source: "relay",
			},
		]);

		expect(record?.source).toBe("api");
		expect(record?.key).toBe("api:env_legacy");
	});

	test("migrates flat mobile capabilities to the versioned manifest", () => {
		const [record] = decodeConnectionRecords([
			{
				key: "paired:env-1",
				host: "desktop.local",
				port: 8787,
				label: "Desktop",
				updatedAt: 4,
				source: "paired",
				capabilities: ["mobile-terminal-v1", "attachment-read-v1"],
			},
		]);

		expect(record?.capabilities).toEqual({
			version: 1,
			features: ["mobile-terminal-v1", "attachment-read-v1"],
		});
		expect(connectionSupports(record, "mobile-terminal-v1")).toBe(true);
	});

	test("rejects malformed persisted values", () => {
		expect(() =>
			decodeConnectionRecords([{ key: "missing-fields" }]),
		).toThrow();
	});

	test("keeps direct connections available without starting remote auth", () => {
		const records = decodeConnectionRecords([
			{
				key: "paired",
				host: "desktop.local",
				port: 8787,
				token: "zt_token",
				label: "Desktop",
				updatedAt: 1,
				source: "paired",
			},
			{
				key: "api",
				host: "api.example",
				port: 443,
				wsBaseUrl: "wss://api.example",
				label: "Remote",
				updatedAt: 2,
				source: "api",
			},
		]);

		expect(
			availableConnections(records, false).map((record) => record.key),
		).toEqual(["paired"]);
		expect(availableConnections(records, true)).toHaveLength(2);
	});

	test("keeps paired and api transports distinct for one computer", () => {
		expect(connectionStorageKey("paired", "env-1")).toBe("paired:env-1");
		expect(connectionStorageKey("api", "env-1")).toBe("api:env-1");
	});

	test("shows one logical computer and prefers its direct transport", () => {
		const records = decodeConnectionRecords([
			{
				key: "api:env-1",
				environmentId: "env-1",
				host: "api.example",
				port: 443,
				wsBaseUrl: "wss://api.example",
				label: "Desktop",
				updatedAt: 2,
				source: "api",
			},
			{
				key: "paired:env-1",
				environmentId: "env-1",
				host: "desktop.local",
				port: 8787,
				label: "Desktop",
				updatedAt: 1,
				source: "paired",
			},
		]);

		expect(availableConnections(records, true)).toMatchObject([
			{ key: "paired:env-1", source: "paired" },
		]);
	});

	test("replaces a paired Mac route without changing its identity", () => {
		const [paired] = decodeConnectionRecords([
			{
				key: "paired:env-1",
				environmentId: "env-1",
				host: "192.168.1.20",
				port: 8787,
				token: "zt_phone",
				serverKeyPin: "sha256/mac-key",
				routeGeneration: 3,
				label: "Desk Mac",
				updatedAt: 1,
				source: "paired",
			},
		]);
		if (paired === undefined) throw new Error("paired record missing");

		const replaced = replaceDiscoveredRoute(paired, {
			host: "10.0.0.44",
			port: 8790,
			pathType: "apple-peer",
		});

		expect(replaced).toMatchObject({
			key: "paired:env-1",
			environmentId: "env-1",
			token: "zt_phone",
			serverKeyPin: "sha256/mac-key",
			host: "10.0.0.44",
			port: 8790,
			pathType: "apple-peer",
			routeGeneration: 4,
		});
	});

	test("does not rewrite an unchanged connection description", () => {
		const records = decodeConnectionRecords([
			{
				key: "paired:env-1",
				host: "desktop.local",
				port: 8787,
				label: "Desk Mac",
				updatedAt: 4,
				source: "paired",
				capabilities: {
					version: 1,
					features: ["mobile-terminal-v1", "attachment-read-v1"],
				},
			},
		]);
		const next = refreshConnectionDescriptor(
			records,
			"paired:env-1",
			"Desk Mac",
			{
				version: 1,
				features: ["attachment-read-v1", "mobile-terminal-v1"],
			},
			10,
		);

		expect(next).toBe(records);
		expect(next[0]?.updatedAt).toBe(4);
	});
});
