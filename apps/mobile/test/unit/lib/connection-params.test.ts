import { expect, test } from "vitest";
import { optionsForConnection } from "../../../src/lib/connection-params";
import { decodeConnectionRecords } from "../../../src/lib/connection-records";

test("unhydrated saved connection ids are not parsed as network addresses", () => {
	for (const source of ["paired", "api", "manual", "cloud", "relay"]) {
		expect(optionsForConnection(`${source}:env_example`, [])).toBeNull();
	}
	expect(optionsForConnection("192.168.1.10:8790", [])).toBeNull();
});

test("legacy raw-host keys still resolve through saved connection records", () => {
	const saved = decodeConnectionRecords([
		{
			key: "192.168.1.10:8790",
			host: "192.168.1.10",
			port: 8790,
			label: "Laptop",
			updatedAt: 1,
		},
	]);
	expect(optionsForConnection("192.168.1.10:8790", saved)).toBe(saved[0]);
	// Organization selection excludes Personal records; the same old route must now fail closed.
	expect(optionsForConnection("192.168.1.10:8790", [])).toBeNull();
});

test("environment aliases resolve only within the visible connection list", () => {
	const visible = decodeConnectionRecords([
		{
			key: "api:environment-a",
			environmentId: "environment-a",
			host: "relay.example",
			port: 443,
			source: "api",
			label: "Server",
			updatedAt: 1,
		},
	]);
	expect(optionsForConnection("environment-a", visible)).toBe(visible[0]);
	expect(optionsForConnection("api:environment-a", visible)).toBe(visible[0]);
	expect(optionsForConnection("environment-b", visible)).toBeNull();
});
