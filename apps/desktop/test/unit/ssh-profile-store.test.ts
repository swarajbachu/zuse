import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { EnvironmentId, RemoteEnvironmentProfile } from "@zuse/contracts";
import { describe, expect, it } from "vitest";

import { RemoteEnvironmentProfileStore } from "../../src/ssh/profile-store.ts";

const profile = RemoteEnvironmentProfile.make({
	profileId: "profile-1",
	environmentId: EnvironmentId.make("env_1"),
	label: "Development box",
	target: {
		alias: "devbox",
		hostname: "devbox.example.test",
		username: "alice",
		port: 22,
	},
	lastConnectedAt: "2026-08-06T00:00:00.000Z",
});

describe("RemoteEnvironmentProfileStore", () => {
	it("persists profiles atomically without connection secrets", async () => {
		const directory = await mkdtemp(join(tmpdir(), "zuse-ssh-profiles-"));
		const store = new RemoteEnvironmentProfileStore(directory);
		await store.put(profile);

		const restored = new RemoteEnvironmentProfileStore(directory);
		await expect(restored.load()).resolves.toEqual([profile]);
		const path = join(directory, "remote-environments.json");
		const raw = await readFile(path, "utf8");
		expect(raw).not.toContain("token");
		expect(raw).not.toContain("password");
		expect((await stat(path)).mode & 0o777).toBe(0o600);
	});

	it("treats corrupted or unsupported documents as empty", async () => {
		const directory = await mkdtemp(join(tmpdir(), "zuse-ssh-profiles-"));
		await writeFile(
			join(directory, "remote-environments.json"),
			'{"schemaVersion":2,"profiles":[]}',
		);
		const store = new RemoteEnvironmentProfileStore(directory);
		await expect(store.load()).resolves.toEqual([]);
	});

	it("migrates the legacy unversioned profile array", async () => {
		const directory = await mkdtemp(join(tmpdir(), "zuse-ssh-profiles-"));
		await writeFile(
			join(directory, "remote-environments.json"),
			JSON.stringify([profile]),
			{ mode: 0o600 },
		);
		const store = new RemoteEnvironmentProfileStore(directory);

		await expect(store.load()).resolves.toEqual([profile]);
	});
});
