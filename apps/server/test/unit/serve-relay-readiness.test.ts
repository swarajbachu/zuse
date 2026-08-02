import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";

import { waitForRelayConfiguration } from "../../src/serve/package-cli.ts";

describe("Zuse Serve relay readiness", () => {
	it("returns the configured environment after tunnel registration", async () => {
		const dataDir = await mkdtemp(join(tmpdir(), "zuse-relay-ready-"));
		const database = new DatabaseSync(join(dataDir, "zuse.sqlite"));
		database.exec(`
			CREATE TABLE relay_config (
				environment_id TEXT NOT NULL,
				relay_url TEXT NOT NULL,
				tunnel_hostname TEXT
			);
			INSERT INTO relay_config VALUES (
				'env_test',
				'https://relay.example.test',
				'env-test.example.test'
			);
		`);
		database.close();

		await expect(waitForRelayConfiguration(dataDir, 50, 1)).resolves.toEqual({
			environmentId: "env_test",
			relayUrl: "https://relay.example.test",
			tunnelHostname: "env-test.example.test",
		});
	});

	it("times out while registration is absent", async () => {
		const dataDir = await mkdtemp(join(tmpdir(), "zuse-relay-missing-"));
		await expect(waitForRelayConfiguration(dataDir, 5, 1)).resolves.toBeNull();
	});
});
