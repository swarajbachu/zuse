import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
	parseTailnetPairingLink,
	TailnetEnvironmentManager,
} from "../../src/tailnet/environment-service.ts";
import { TailnetEnvironmentProfileStore } from "../../src/tailnet/profile-store.ts";

describe("Tailnet environment pairing", () => {
	it("parses a secure Zuse pairing link", () => {
		expect(
			parseTailnetPairingLink(
				"zuse:///connect/pair?pairingUrl=wss%3A%2F%2Fbuild.example.ts.net%2Frpc#token=zp_once",
			),
		).toEqual({
			code: "zp_once",
			httpBaseUrl: "https://build.example.ts.net",
			wsBaseUrl: "wss://build.example.ts.net/rpc",
		});
	});

	it("rejects insecure and incomplete links", () => {
		expect(() =>
			parseTailnetPairingLink(
				"zuse:///connect/pair?pairingUrl=ws%3A%2F%2Fbuild.local%3A47837#token=zp_once",
			),
		).toThrow(/secure wss/u);
		expect(() =>
			parseTailnetPairingLink(
				"zuse:///connect/pair?pairingUrl=wss%3A%2F%2Fbuild.example.ts.net%2Frpc",
			),
		).toThrow(/incomplete/u);
		expect(() =>
			parseTailnetPairingLink(
				"zuse:///connect/pair?pairingUrl=wss%3A%2F%2Fexample.com%2Frpc#token=zp_once",
			),
		).toThrow(/Tailscale device/u);
	});

	it("stores only profile metadata on disk and restores the secret from the vault", async () => {
		const directory = await mkdtemp(join(tmpdir(), "zuse-tailnet-test-"));
		const credentials = new Map<string, string>();
		const vault = {
			get: async (profileId: string) => credentials.get(profileId) ?? null,
			set: async (profileId: string, token: string) => {
				credentials.set(profileId, token);
			},
			remove: async (profileId: string) => {
				credentials.delete(profileId);
			},
		};
		const fetcher = vi.fn(
			async () =>
				new Response(
					JSON.stringify({ token: "zt_secret", environmentId: "env_remote" }),
					{ status: 200 },
				),
		);
		const manager = new TailnetEnvironmentManager(directory, vault, fetcher);
		await manager.initialize();
		const connection = await manager.ensure({
			pairingLink:
				"zuse:///connect/pair?pairingUrl=wss%3A%2F%2Fbuild.example.ts.net%2Frpc#token=zp_once",
		});
		const profilePath = join(directory, "tailnet-environments.json");
		expect(await readFile(profilePath, "utf8").catch(() => null)).toBeNull();
		expect(credentials.size).toBe(0);
		await manager.confirmEnvironment(
			connection.profile.profileId,
			connection.profile.environmentId,
		);
		const contents = await readFile(profilePath, "utf8");
		expect(contents).not.toContain("zt_secret");
		expect((await stat(profilePath)).mode & 0o777).toBe(0o600);

		const restored = new TailnetEnvironmentManager(directory, vault);
		await restored.initialize();
		const reconnect = await restored.ensure({
			profileId: connection.profile.profileId,
		});
		expect(reconnect.wsUrl).toContain("token=zt_secret");
	});

	it("rejects an environment identity mismatch before persistence", async () => {
		const directory = await mkdtemp(join(tmpdir(), "zuse-tailnet-test-"));
		const credentials = new Map<string, string>();
		const manager = new TailnetEnvironmentManager(
			directory,
			{
				get: async (profileId) => credentials.get(profileId) ?? null,
				set: async (profileId, token) => {
					credentials.set(profileId, token);
				},
				remove: async (profileId) => {
					credentials.delete(profileId);
				},
			},
			async () =>
				new Response(
					JSON.stringify({ token: "zt_secret", environmentId: "env_expected" }),
					{ status: 200 },
				),
		);
		await manager.initialize();
		const connection = await manager.ensure({
			pairingLink:
				"zuse:///connect/pair?pairingUrl=wss%3A%2F%2Fbuild.example.ts.net%2Frpc#token=zp_once",
		});
		await expect(
			manager.confirmEnvironment(connection.profile.profileId, "env_other"),
		).rejects.toThrow(/different Zuse computer/u);
		expect(manager.listProfiles()).toEqual([]);
		expect(credentials.size).toBe(0);
	});

	it("surfaces filesystem failures instead of replacing profiles", async () => {
		const directory = await mkdtemp(join(tmpdir(), "zuse-tailnet-test-"));
		const notDirectory = join(directory, "not-a-directory");
		await writeFile(notDirectory, "occupied", "utf8");
		await expect(
			new TailnetEnvironmentProfileStore(notDirectory).load(),
		).rejects.toThrow();
	});
});
