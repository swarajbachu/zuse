import {
	mkdir,
	mkdtemp,
	readFile,
	rm,
	stat,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { zipSync } from "fflate";
import { afterEach, describe, expect, it } from "vitest";
import {
	distributionFor,
	installCatalogAgent,
	platformTarget,
	readCatalog,
	safeArchivePath,
} from "../../src/provider/acp/catalog.ts";
import { makeAcpAgentStore, probeAcp } from "../../src/provider/acp/service.ts";

const directories: string[] = [];
const directory = async () => {
	const result = await mkdtemp(join(tmpdir(), "zuse-acp-test-"));
	directories.push(result);
	return result;
};
afterEach(async () => {
	await Promise.all(
		directories
			.splice(0)
			.map((path) => rm(path, { recursive: true, force: true })),
	);
});
const fixture = fileURLToPath(
	new URL(
		"../../../../tests/testkit/fixtures/fake-acp-provider.mjs",
		import.meta.url,
	),
);
const secretStore = () => {
	const values = new Map<string, string>();
	return {
		values,
		get: async (id: string) => values.get(id) ?? null,
		set: async (id: string, value: string) => {
			values.set(id, value);
		},
		remove: async (id: string) => {
			values.delete(id);
		},
	};
};

describe("host ACP agents", () => {
	it.each([
		"claude",
		"codex",
	] as const)("keeps %s account homes independent through edits, duplication and restart", async (provider) => {
		const root = await directory();
		const secrets = secretStore();
		const store = makeAcpAgentStore(root, secrets);
		const original = await store.save({
			name: "Agent",
			command: process.execPath,
			args: [fixture],
			enabled: true,
			env: {
				ANTHROPIC_API_KEY: "old-claude",
				OPENAI_API_KEY: "old-codex",
				CLAUDE_CODE_OAUTH_TOKEN: "old-token",
				CLAUDE_CONFIG_DIR: "/old",
				CODEX_HOME: "/old",
				KEEP: "value",
			},
		});
		const account = await store.duplicate(original.id, provider);
		const another = await store.duplicate(account.id);
		const launch = await store.launch(account.id);
		const selector = provider === "claude" ? "CLAUDE_CONFIG_DIR" : "CODEX_HOME";
		expect(launch.env?.[selector]).toBe(join(root, "accounts", account.id));
		expect((await store.launch(another.id)).env?.[selector]).not.toBe(
			launch.env?.[selector],
		);
		expect(launch.env?.KEEP).toBe("value");
		if (provider === "claude") {
			expect(launch.env?.CLAUDE_SECURESTORAGE_CONFIG_DIR).toBe(
				launch.env?.CLAUDE_CONFIG_DIR,
			);
			expect(launch.env?.ANTHROPIC_API_KEY).toBeUndefined();
			expect(launch.env?.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
		} else expect(launch.env?.OPENAI_API_KEY).toBeUndefined();
		await store.save({
			...account,
			name: "Renamed",
			env: { [selector]: "/wrong", KEEP: "changed" },
		});
		expect(
			(await makeAcpAgentStore(root, secrets).launch(account.id)).env?.[
				selector
			],
		).toBe(launch.env?.[selector]);
		await store.remove(account.id);
		await expect(store.launch(account.id)).rejects.toThrow("removed");
		expect((await store.launch(another.id)).env?.[selector]).toBe(
			join(root, "accounts", another.id),
		);
	});
	it("persists multiple instances, redacts secrets, duplicates credentials, and isolates hosts", async () => {
		const root = await directory();
		const secrets = secretStore();
		const store = makeAcpAgentStore(root, secrets);
		const original = await store.save({
			name: "First",
			command: process.execPath,
			args: [fixture],
			enabled: true,
			env: { TOKEN: "very-private" },
		});
		const duplicate = await store.duplicate(original.id);
		expect(duplicate.id).not.toBe(original.id);
		expect((await store.launch(duplicate.id)).env).toEqual({
			TOKEN: "very-private",
		});
		expect(await readFile(join(root, "agents.json"), "utf8")).not.toContain(
			"very-private",
		);
		expect(await makeAcpAgentStore(root, secrets).list()).toHaveLength(2);
		expect(await makeAcpAgentStore(await directory(), secrets).list()).toEqual(
			[],
		);
		const snapshot = await store.launch(original.id);
		await store.save({ ...original, command: "new-command", enabled: false });
		expect(snapshot.command).toBe(process.execPath);
		await expect(store.launch(original.id)).rejects.toThrow("disabled");
		await store.remove(original.id);
		await expect(store.launch(original.id)).rejects.toThrow("removed");
		expect(await store.get(duplicate.id)).toBeDefined();
	});
	it("does not lose concurrent additions", async () => {
		const store = makeAcpAgentStore(await directory(), secretStore());
		await Promise.all(
			Array.from({ length: 6 }, (_, index) =>
				store.save({
					name: `Agent ${index}`,
					command: "agent",
					args: [],
					enabled: true,
				}),
			),
		);
		expect(await store.list()).toHaveLength(6);
	});
	it("rejects invalid commands and environment variable names", async () => {
		const store = makeAcpAgentStore(await directory(), secretStore());
		await expect(
			store.save({ name: "Invalid", command: "", args: [], enabled: true }),
		).rejects.toThrow("executable");
		await expect(
			store.save({
				name: "Invalid",
				command: "agent",
				args: [],
				enabled: true,
				env: { "INVALID=KEY": "x" },
			}),
		).rejects.toThrow("environment");
	});
	it("probes two actual ACP processes independently", async () => {
		const root = await directory();
		const results = await Promise.all(
			[1, 2].map(() =>
				probeAcp(
					{
						command: process.execPath,
						args: [fixture],
						env: { ZUSE_FAKE_ACP_STATE_DIR: root },
					},
					root,
				),
			),
		);
		expect(results.map((result) => result.status)).toEqual(["ready", "ready"]);
		expect(results[0]?.loadSession).toBe(true);
	});
	it("reports a missing executable without hanging", async () => {
		const result = await probeAcp(
			{ command: "/missing/zuse-agent", args: [] },
			await directory(),
		);
		expect(result.status).toBe("error");
		expect(result.message).toContain("ENOENT");
	});
});
describe("ACP catalog", () => {
	it("falls back to bundled entries offline", async () => {
		const catalog = await readCatalog(await directory(), async () => {
			throw new Error("offline");
		});
		expect(catalog.agents.length).toBeGreaterThan(10);
	});
	it("prefers a host binary, then npm, then uv, and rejects unsupported hosts", () => {
		const agent = {
			id: "test",
			name: "Test",
			description: "",
			version: "1.0.0",
			distribution: {
				binary: {
					"linux-x86_64": { archive: "https://example.com/a", cmd: "agent" },
				},
				npx: { package: "agent@1.0.0" },
				uvx: { package: "agent==1.0.0" },
			},
		};
		expect(distributionFor(agent, "linux-x86_64")?.kind).toBe("binary");
		expect(distributionFor(agent, "darwin-aarch64")?.kind).toBe("npx");
		expect(
			distributionFor({
				...agent,
				distribution: { uvx: agent.distribution.uvx },
			})?.kind,
		).toBe("uvx");
		expect(distributionFor({ ...agent, distribution: {} })).toBeNull();
	});
	it("rejects escaping archive paths", () => {
		expect(() => safeArchivePath("/tmp/install", "../secrets")).toThrow();
		expect(() => safeArchivePath("/tmp/install", "/etc/passwd")).toThrow();
		expect(() => safeArchivePath("/tmp/install", "C:\\outside")).toThrow();
		expect(safeArchivePath("/tmp/install", "./bin/agent")).toBe(
			"/tmp/install/bin/agent",
		);
	});
});

it("preserves the installed agent and credentials after a failed update", async () => {
	const root = await directory();
	const secrets = secretStore();
	let failing = false;
	const store = makeAcpAgentStore(root, secrets, {
		catalog: async () => ({
			version: "1",
			agents: [
				{
					id: "fixture",
					name: "Fixture",
					description: "",
					version: failing ? "2.0.0" : "1.0.0",
					distribution: {},
				},
			],
		}),
		install: async () => {
			if (failing) throw new Error("download interrupted");
			return {
				command: process.execPath,
				args: [fixture],
				env: { TOKEN: "keep" },
			};
		},
		probe: async () => ({
			status: "ready",
			message: "Connected",
			authMethods: [],
			models: [],
			modes: [],
			commands: [],
			loadSession: true,
		}),
	});
	const installed = await store.install("fixture");
	failing = true;
	await expect(store.install("fixture", installed.id)).rejects.toThrow(
		"download interrupted",
	);
	expect((await store.get(installed.id)).version).toBe("1.0.0");
	expect((await store.launch(installed.id)).env).toEqual({ TOKEN: "keep" });
});
it("saves new installs before testing and verifies updates first", async () => {
	const root = await directory();
	const probes: string[] = [];
	const caches: string[] = [];
	const store = makeAcpAgentStore(root, secretStore(), {
		catalog: async () => ({
			version: "1",
			agents: [
				{
					id: "fixture",
					name: "Fixture",
					description: "",
					version: "1.0.0",
					distribution: {},
				},
			],
		}),
		install: async (_agent, _destination, _fetch, _resolve, cache) => {
			caches.push(cache ?? "");
			return { command: process.execPath, args: [fixture], env: {} };
		},
		probe: async (launch) => {
			probes.push(launch.command);
			return {
				status: "ready",
				message: "Connected",
				authMethods: [],
				models: [],
				modes: [],
				commands: [],
				loadSession: true,
			};
		},
	});
	const installed = await store.install("fixture");
	expect(installed.probe).toBeUndefined();
	expect(probes).toHaveLength(0);
	await store.install("fixture", installed.id);
	expect(probes).toHaveLength(1);
	expect(new Set(caches)).toEqual(new Set([join(root, "cache")]));
});
const fileInstaller = async (_agent: unknown, destination: string) => {
	await mkdir(destination, { recursive: true });
	await writeFile(join(destination, "agent"), "");
	return {
		command: join(destination, "agent"),
		args: [],
		env: { TOKEN: "secret" },
	};
};
const readyProbe = async () => ({
	status: "ready" as const,
	message: "Connected",
	authMethods: [],
	models: [],
	modes: [],
	commands: [],
	loadSession: true,
});
const fixtureCatalog = async () => ({
	version: "1",
	agents: [
		{
			id: "fixture",
			name: "Fixture",
			description: "",
			version: "1.0.0",
			distribution: {},
		},
	],
});
it.each([
	"claude",
	"codex",
] as const)("keeps the %s account home during catalog updates", async (provider) => {
	const root = await directory();
	const homes: Array<string | undefined> = [];
	const selector = provider === "claude" ? "CLAUDE_CONFIG_DIR" : "CODEX_HOME";
	const store = makeAcpAgentStore(root, secretStore(), {
		catalog: fixtureCatalog,
		install: fileInstaller,
		probe: async (launch) => {
			homes.push(launch.env?.[selector]);
			expect(launch.unsetEnv).toContain(
				provider === "claude" ? "ANTHROPIC_API_KEY" : "OPENAI_API_KEY",
			);
			return readyProbe();
		},
	});
	const original = await store.install("fixture");
	const account = await store.duplicate(original.id, provider);
	const before = await store.launch(account.id);
	await store.install("fixture", account.id);
	const after = await store.launch(account.id);
	expect(after.env?.[selector]).toBe(before.env?.[selector]);
	expect(homes).toEqual([before.env?.[selector]]);
	expect((await store.get(account.id)).accountProvider).toBe(provider);
});
it("releases replaced credentials and installations", async () => {
	const root = await directory();
	const secrets = secretStore();
	const store = makeAcpAgentStore(root, secrets, {
		catalog: fixtureCatalog,
		install: fileInstaller,
		probe: readyProbe,
	});
	const installed = await store.install("fixture");
	const first = dirname((await store.launch(installed.id)).command);
	await store.install("fixture", installed.id);
	const second = dirname((await store.launch(installed.id)).command);
	expect(second).not.toBe(first);
	await expect(stat(first)).rejects.toThrow();
	expect(secrets.values.size).toBe(1);
	await store.remove(installed.id);
	expect(secrets.values.size).toBe(0);
	await expect(
		stat(join(root, "installations", installed.id)),
	).rejects.toThrow();
});
it("keeps an installation that a duplicate still runs from", async () => {
	const root = await directory();
	const store = makeAcpAgentStore(root, secretStore(), {
		catalog: fixtureCatalog,
		install: fileInstaller,
		probe: readyProbe,
	});
	const original = await store.install("fixture");
	const copy = await store.duplicate(original.id);
	await store.remove(original.id);
	await expect(
		stat((await store.launch(copy.id)).command),
	).resolves.toBeDefined();
});
it("fails instead of hanging on an unsupported zip compression method", async () => {
	const root = await directory();
	const archive = zipSync(
		{
			agent: [
				new TextEncoder().encode("binary"),
				{ os: 3, attrs: 0o755 << 16 },
			],
		},
		{ level: 0 },
	);
	// Rewrite the compression method (stored → 99) in the local and central headers.
	const view = new DataView(archive.buffer);
	for (let offset = 0; offset < archive.length - 4; offset++) {
		const signature = view.getUint32(offset, true);
		if (signature === 0x04034b50) view.setUint16(offset + 8, 99, true);
		if (signature === 0x02014b50) view.setUint16(offset + 10, 99, true);
	}
	await expect(
		installCatalogAgent(
			{
				id: "zip",
				name: "Zip",
				description: "",
				version: "1",
				distribution: {
					binary: {
						[platformTarget()]: {
							archive: "https://example.com/agent.zip",
							cmd: "./agent",
						},
					},
				},
			},
			root,
			async () => new Response(archive),
		),
	).rejects.toThrow();
});
it("discovers models, modes and commands and handles advertised authentication", async () => {
	const root = await directory();
	const launch = {
		command: process.execPath,
		args: [fixture],
		env: { ZUSE_FAKE_ACP_STATE_DIR: root, ZUSE_FAKE_ACP_SCENARIO: "discovery" },
	};
	const discovered = await probeAcp(launch, root);
	expect(discovered.models).toEqual([{ id: "test-model", name: "Test model" }]);
	expect(discovered.modes).toEqual([{ id: "code", name: "Code" }]);
	expect(discovered.commands).toEqual([
		{ name: "explain", description: "Explain the workspace" },
	]);
	const authLaunch = {
		...launch,
		env: { ...launch.env, ZUSE_FAKE_ACP_SCENARIO: "authentication" },
	};
	expect((await probeAcp(authLaunch, root)).status).toBe(
		"authentication-required",
	);
	expect((await probeAcp(authLaunch, root, "cached_token")).status).toBe(
		"ready",
	);
});

it("retains the last valid registry when a refresh is malformed", async () => {
	const root = await directory();
	const good = { version: "1", agents: [] };
	await readCatalog(root, async () => Response.json(good));
	expect(
		await readCatalog(root, async () => Response.json({ agents: "invalid" })),
	).toEqual(good);
});
it("rejects binary checksum failures before creating the executable", async () => {
	const root = await directory();
	await expect(
		installCatalogAgent(
			{
				id: "bad",
				name: "Bad",
				description: "",
				version: "1",
				distribution: {
					binary: {
						[platformTarget()]: {
							archive: "https://example.com/agent",
							cmd: "agent",
							sha256: "0".repeat(64),
						},
					},
				},
			},
			root,
			async () => new Response("corrupt"),
		),
	).rejects.toThrow("checksum");
	await expect(readFile(join(root, "agent"))).rejects.toThrow();
});
it("keeps helper executables runnable when extracting zip agents", async () => {
	const root = await directory();
	const archive = zipSync({
		"bin/agent": [
			new TextEncoder().encode("#!/bin/sh\n"),
			{ os: 3, attrs: 0o755 << 16 },
		],
		"bin/helper": [
			new TextEncoder().encode("#!/bin/sh\n"),
			{ os: 3, attrs: 0o755 << 16 },
		],
		"README.md": [
			new TextEncoder().encode("docs"),
			{ os: 3, attrs: 0o644 << 16 },
		],
	});
	const installed = await installCatalogAgent(
		{
			id: "zip",
			name: "Zip",
			description: "",
			version: "1",
			distribution: {
				binary: {
					[platformTarget()]: {
						archive: "https://example.com/agent.zip",
						cmd: "./bin/agent",
					},
				},
			},
		},
		root,
		async () => new Response(archive),
	);
	expect(installed.command).toBe(join(root, "bin/agent"));
	// Windows has no POSIX execute bits; there, extraction itself is the check.
	if (process.platform !== "win32") {
		expect((await stat(join(root, "bin/helper"))).mode & 0o100).toBe(0o100);
		expect((await stat(join(root, "README.md"))).mode & 0o111).toBe(0);
	} else {
		await expect(stat(join(root, "bin/helper"))).resolves.toBeDefined();
		await expect(stat(join(root, "README.md"))).resolves.toBeDefined();
	}
	await expect(stat(join(root, "download"))).rejects.toThrow();
});
it("reports missing package runners with a setup instruction", async () => {
	await expect(
		installCatalogAgent(
			{
				id: "npm",
				name: "npm",
				description: "",
				version: "1.0.0",
				distribution: { npx: { package: "agent@1.0.0" } },
			},
			await directory(),
			fetch,
			async () => "/missing/npx",
		),
	).rejects.toThrow("Node.js and npm");
});

it("offers Amp and the pinned community OMP adapter with source provenance", async () => {
	const store = makeAcpAgentStore(await directory(), secretStore(), {
		catalog: (directory) =>
			readCatalog(directory, async () => {
				throw new Error("offline");
			}),
	});
	const entries = await store.catalog();
	expect(entries.find((entry) => entry.id === "amp-acp")).toMatchObject({
		origin: "registry",
	});
	expect(entries.find((entry) => entry.id === "omp-acp")).toMatchObject({
		origin: "community",
		version: "0.1.2",
		compatible: true,
	});
});
it("prefers an upstream OMP entry without duplicating the community adapter", async () => {
	const store = makeAcpAgentStore(await directory(), secretStore(), {
		catalog: async () => ({
			version: "1",
			agents: [
				{
					id: "omp-acp",
					name: "Official OMP",
					description: "",
					version: "0.2.0",
					distribution: { npx: { package: "omp-acp@0.2.0" } },
				},
			],
		}),
	});
	const entries = await store.catalog();
	expect(entries.filter((entry) => entry.id === "omp-acp")).toEqual([
		expect.objectContaining({ origin: "registry", version: "0.2.0" }),
	]);
});
