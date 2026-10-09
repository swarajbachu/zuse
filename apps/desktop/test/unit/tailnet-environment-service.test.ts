import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { EnvironmentId, TailnetEnvironmentProfile } from "@zuse/contracts";
import { describe, expect, it, vi } from "vitest";

import {
	parseTailnetPairingLink,
	supersededTailnetProfiles,
	TailnetEnvironmentManager,
} from "../../src/tailnet/environment-service.ts";
import { TailnetEnvironmentProfileStore } from "../../src/tailnet/profile-store.ts";

describe("Tailnet environment pairing", () => {
	it("uses a stable per-desktop identity instead of the remote profile id", async () => {
		const firstDirectory = await mkdtemp(
			join(tmpdir(), "zuse-tailnet-client-"),
		);
		const secondDirectory = await mkdtemp(
			join(tmpdir(), "zuse-tailnet-client-"),
		);
		const deviceIds: string[] = [];
		const fetcher = vi.fn(
			async (_url: Parameters<typeof fetch>[0], init?: RequestInit) => {
				const body = JSON.parse(String(init?.body)) as { deviceId: string };
				deviceIds.push(body.deviceId);
				return new Response(
					JSON.stringify({ token: "zt_secret", environmentId: "env_remote" }),
					{ status: 200 },
				);
			},
		);
		const vault = {
			get: async () => null,
			set: async () => undefined,
			remove: async () => undefined,
		};
		const pairingLink =
			"zuse:///connect/pair?pairingUrl=wss%3A%2F%2Fbuild.example.ts.net%2Frpc#token=zp_once";
		await new TailnetEnvironmentManager(firstDirectory, vault, fetcher).ensure({
			pairingLink,
		});
		await new TailnetEnvironmentManager(firstDirectory, vault, fetcher).ensure({
			pairingLink,
		});
		await new TailnetEnvironmentManager(secondDirectory, vault, fetcher).ensure(
			{
				pairingLink,
			},
		);

		expect(deviceIds[0]).toMatch(/^desktop_/u);
		expect(deviceIds[1]).toBe(deviceIds[0]);
		expect(deviceIds[2]).not.toBe(deviceIds[0]);
	});

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

	it("parses the canonical browser pairing link", () => {
		expect(
			parseTailnetPairingLink("https://build.example.ts.net/#pair=zp_once"),
		).toEqual({
			code: "zp_once",
			httpBaseUrl: "https://build.example.ts.net",
			wsBaseUrl: "wss://build.example.ts.net/rpc",
		});
	});

	it("parses secure links to hosts outside the tailnet", () => {
		expect(
			parseTailnetPairingLink(
				"zuse:///connect/pair?pairingUrl=wss%3A%2F%2Fexample.com%2Frpc#token=zp_once",
			),
		).toEqual({
			code: "zp_once",
			httpBaseUrl: "https://example.com",
			wsBaseUrl: "wss://example.com/rpc",
		});
	});

	it("parses plaintext links only on the private local network", () => {
		expect(
			parseTailnetPairingLink(
				"zuse:///connect/pair?pairingUrl=ws%3A%2F%2F192.168.1.50%3A4859#token=ABCDEFGH",
			),
		).toEqual({
			code: "ABCDEFGH",
			httpBaseUrl: "http://192.168.1.50:4859",
			wsBaseUrl: "ws://192.168.1.50:4859/rpc",
		});
	});

	it("rejects insecure and incomplete links", () => {
		expect(() =>
			parseTailnetPairingLink(
				"zuse:///connect/pair?pairingUrl=ws%3A%2F%2Fexample.com%3A47837#token=zp_once",
			),
		).toThrow(/public connect links must use a secure wss/iu);
		expect(() =>
			parseTailnetPairingLink(
				"zuse:///connect/pair?pairingUrl=wss%3A%2F%2Fbuild.example.ts.net%2Frpc",
			),
		).toThrow(/incomplete/u);
		expect(() =>
			parseTailnetPairingLink(
				"zuse:///connect/pair?pairingUrl=wss%3A%2F%2Fuser%3Apass%40example.com%2Frpc#token=zp_once",
			),
		).toThrow(/reachable Zuse computer/u);
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

	it("keeps one saved route per computer when it is paired again at a new address", async () => {
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
		let issued = 0;
		const fetcher = vi.fn(
			async () =>
				new Response(
					JSON.stringify({
						token: `zt_secret_${++issued}`,
						environmentId: "env_mac",
					}),
					{ status: 200 },
				),
		);
		const manager = new TailnetEnvironmentManager(directory, vault, fetcher);
		await manager.initialize();
		const first = await manager.ensure({
			pairingLink: "https://old-name.example.ts.net/#pair=zp_once",
		});
		await manager.confirmEnvironment(first.profile.profileId, "env_mac");
		const second = await manager.ensure({
			pairingLink: "https://new-name.example.ts.net/#pair=zp_twice",
		});
		await manager.confirmEnvironment(second.profile.profileId, "env_mac");

		expect(manager.listProfiles().map((profile) => profile.profileId)).toEqual([
			second.profile.profileId,
		]);
		expect([...credentials.keys()]).toEqual([second.profile.profileId]);
	});

	it("drops older duplicate profiles of one computer on load", async () => {
		const directory = await mkdtemp(join(tmpdir(), "zuse-tailnet-test-"));
		const store = new TailnetEnvironmentProfileStore(directory);
		await store.load();
		const profile = (profileId: string, lastConnectedAt: string) =>
			TailnetEnvironmentProfile.make({
				profileId,
				environmentId: EnvironmentId.make("env_mac"),
				label: "Mac",
				httpBaseUrl: `https://${profileId}.example.ts.net`,
				wsBaseUrl: `wss://${profileId}.example.ts.net/rpc`,
				lastConnectedAt,
			});
		await store.put(profile("tailnet_old", "2026-09-01T00:00:00.000Z"));
		await store.put(profile("tailnet_new", "2026-10-01T00:00:00.000Z"));
		const removed: string[] = [];
		const manager = new TailnetEnvironmentManager(directory, {
			get: async () => null,
			set: async () => undefined,
			remove: async (profileId) => {
				removed.push(profileId);
			},
		});

		const loaded = await manager.initialize();

		expect(loaded.map((item) => item.profileId)).toEqual(["tailnet_new"]);
		expect(removed).toEqual(["tailnet_old"]);
	});

	it("keeps the newest valid profile when timestamps are malformed or tied", () => {
		const profile = (profileId: string, lastConnectedAt: string) =>
			TailnetEnvironmentProfile.make({
				profileId,
				environmentId: EnvironmentId.make("env_mac"),
				label: "Mac",
				httpBaseUrl: `https://${profileId}.example.ts.net`,
				wsBaseUrl: `wss://${profileId}.example.ts.net/rpc`,
				lastConnectedAt,
			});
		const ids = (profiles: ReadonlyArray<{ profileId: string }>) =>
			profiles.map((item) => item.profileId).sort();

		// A malformed timestamp would win a string comparison ("z" > "2"); it
		// must sort as oldest instead.
		expect(
			ids(
				supersededTailnetProfiles([
					profile("tailnet_valid", "2026-09-01T00:00:00.000Z"),
					profile("tailnet_broken", "zzz"),
				]),
			),
		).toEqual(["tailnet_broken"]);
		// Equal timestamps keep the same profile regardless of input order.
		const tied = [
			profile("tailnet_a", "2026-09-01T00:00:00.000Z"),
			profile("tailnet_b", "2026-09-01T00:00:00.000Z"),
		];
		expect(ids(supersededTailnetProfiles(tied))).toEqual(["tailnet_a"]);
		expect(ids(supersededTailnetProfiles([...tied].reverse()))).toEqual([
			"tailnet_a",
		]);
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
