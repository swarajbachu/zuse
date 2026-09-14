import { generateKeyPairSync, sign } from "node:crypto";
import {
	mkdir,
	mkdtemp,
	readFile,
	rm,
	stat,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { compileExtension } from "../../src/compiler.ts";
import { ExtensionHost } from "../../src/host.ts";
import { verifyMarketplaceCatalog } from "../../src/marketplace.ts";

const manifest = (
	capabilities: ReadonlyArray<string> = ["rpc"],
	contributions: ReadonlyArray<string> = [],
) => ({
	schemaVersion: 1,
	id: "test-extension",
	name: "Test Extension",
	description: "Extension host fixture",
	version: "1.0.0",
	entry: "index.ts",
	zuseApi: "^1.0.0",
	contributions,
	capabilities,
	publisher: { name: "Zuse Tests" },
});

const source = `
import { Schema } from "effect";
import { defineRpc } from "@zuse/extension-sdk";
const echo = defineRpc({ name: "echo", input: Schema.String, output: Schema.String });
export default function setup(extension) {
  if (extension.target === "server") {
    extension.handle(echo, (value) => value);
  }
  return () => {};
}`;

const fixture = async () => {
	const root = await mkdtemp(join(tmpdir(), "zuse-extension-host-"));
	const extension = join(root, "extension");
	await mkdir(extension);
	await writeFile(
		join(extension, "zuse-extension.json"),
		JSON.stringify(manifest()),
	);
	await writeFile(join(extension, "index.ts"), source);
	return { root, extension };
};

const makeHost = (root: string) =>
	new ExtensionHost({
		rootDirectory: join(root, "host"),
		secretStore: {
			get: async () => null,
			set: async () => {},
			delete: async () => {},
		},
	});

describe("ExtensionHost", () => {
	// Compilation and real child-process startup need the same CI budget as the other lifecycle tests.
	it("stays globally disabled by default and invokes validated RPCs after enable", async () => {
		const { root, extension } = await fixture();
		const host = makeHost(root);
		try {
			await host.start();
			await host.execute({
				_tag: "install",
				source: { _tag: "directory", path: extension },
				grantedCapabilities: ["rpc"],
			});
			expect(host.snapshot().globallyEnabled).toBe(false);
			expect(host.snapshot().items[0]?.status).toBe("disabled");
			await host.execute({ _tag: "set-global-enabled", enabled: true });
			expect(await host.invoke("test-extension", "echo", "ok")).toBe("ok");
			await expect(
				host.invoke("test-extension", "echo", 1),
			).rejects.toMatchObject({
				code: "rpc-failed",
			});
		} finally {
			await host.stop();
			await rm(root, { recursive: true, force: true });
		}
	}, 20_000);

	it("rolls back an installation when its configuration cannot be committed", async () => {
		const { root, extension } = await fixture();
		const host = makeHost(root);
		await host.start();
		const obstruction = join(
			root,
			"host",
			`extensions.json.tmp.${process.pid}`,
		);
		await mkdir(obstruction);
		try {
			await expect(
				host.execute({
					_tag: "install",
					source: { _tag: "directory", path: extension },
					grantedCapabilities: ["rpc"],
				}),
			).rejects.toThrow();
			expect(host.snapshot().items).toHaveLength(0);
			await rm(obstruction, { recursive: true });
			await host.execute({
				_tag: "install",
				source: { _tag: "directory", path: extension },
				grantedCapabilities: ["rpc"],
			});
			expect(host.snapshot().items).toHaveLength(1);
		} finally {
			await host.stop();
		}
	}, 20_000);

	it("recovers uncommitted generations and serializes concurrent lifecycle changes", async () => {
		const { root, extension } = await fixture();
		const first = makeHost(root);
		await first.start();
		await first.execute({ _tag: "set-global-enabled", enabled: true });
		await first.execute({
			_tag: "install",
			source: { _tag: "directory", path: extension },
			grantedCapabilities: ["rpc"],
		});
		await first.stop();
		const orphan = join(
			root,
			"host",
			"artifacts",
			"test-extension",
			"interrupted-candidate",
		);
		await mkdir(orphan, { recursive: true });
		await writeFile(join(orphan, "state.json"), '{"uncommitted":true}');
		const host = makeHost(root);
		try {
			await host.start();
			expect(await stat(orphan).catch(() => null)).toBeNull();
			expect(await host.invoke("test-extension", "echo", "preserved")).toBe(
				"preserved",
			);
			await Promise.all([
				host.execute({ _tag: "reload", id: "test-extension" }),
				host.execute({ _tag: "disable", id: "test-extension" }),
			]);
			expect(host.snapshot().items[0]?.status).toBe("disabled");
			await host.execute({ _tag: "enable", id: "test-extension" });
			expect(await host.invoke("test-extension", "echo", "recovered")).toBe(
				"recovered",
			);
		} finally {
			await host.stop();
		}
	}, 20_000);

	// This exercises several real process starts, rollback, and an application restart.
	it("does not commit candidate storage when initialization fails", async () => {
		const { root, extension } = await fixture();
		await writeFile(
			join(extension, "zuse-extension.json"),
			JSON.stringify(manifest(["rpc", "storage"])),
		);
		await writeFile(
			join(extension, "index.ts"),
			`
import { Schema } from "effect";
import { defineRpc } from "@zuse/extension-sdk";
export default function setup(e) {
 if (e.target === "server") {
  e.handle(defineRpc({name:"read",input:Schema.String,output:Schema.Unknown}), key => e.storage.get(key));
  e.handle(defineRpc({name:"write",input:Schema.String,output:Schema.Void}), value => e.storage.set("value",value));
 }
 return () => {};
}`,
		);
		const host = makeHost(root);
		await host.start();
		try {
			await host.execute({
				_tag: "install",
				source: { _tag: "directory", path: extension },
				grantedCapabilities: ["rpc", "storage"],
			});
			await host.execute({ _tag: "set-global-enabled", enabled: true });
			await host.invoke("test-extension", "write", "original");
			await writeFile(
				join(extension, "index.ts"),
				`export default async function setup(e) { if(e.target === "server") { await e.storage.set("value","corrupt"); throw new Error("migration failed"); } return () => {}; }`,
			);
			await expect(
				host.execute({ _tag: "reload", id: "test-extension" }),
			).rejects.toThrow();
			await host.stop();
			const restarted = makeHost(root);
			await restarted.start();
			try {
				expect(await restarted.invoke("test-extension", "read", "value")).toBe(
					"original",
				);
			} finally {
				await restarted.stop();
			}
		} finally {
			await host.stop();
		}
	}, 20_000);

	it("stops recovering an extension that repeatedly becomes ready then crashes", async () => {
		const { root, extension } = await fixture();
		await writeFile(
			join(extension, "index.ts"),
			`export default function setup(e) { if(e.target === "server") { console.log("BOOT"); setTimeout(() => process.exit(1), 100); } return () => {}; }`,
		);
		const host = makeHost(root);
		await host.start();
		try {
			await host.execute({ _tag: "set-global-enabled", enabled: true });
			await host.execute({
				_tag: "install",
				source: { _tag: "directory", path: extension },
				grantedCapabilities: ["rpc"],
			});
			await new Promise((resolve) => setTimeout(resolve, 8500));
			expect(
				host.logs("test-extension").filter((log) => log.message === "BOOT"),
			).toHaveLength(4);
			expect(host.snapshot().items[0]?.status).toBe("failed");
		} finally {
			await host.stop();
		}
	}, 15000);

	it("requires explicit approval for every capability", async () => {
		const { root, extension } = await fixture();
		await writeFile(
			join(extension, "zuse-extension.json"),
			JSON.stringify(manifest(["rpc", "network"])),
		);
		const host = makeHost(root);
		await host.start();
		await expect(
			host.execute({
				_tag: "install",
				source: { _tag: "directory", path: extension },
				grantedCapabilities: ["rpc"],
			}),
		).rejects.toMatchObject({ code: "capability-approval-required" });
		await host.stop();
	});

	it("rejects client imports from server-only modules", async () => {
		const { extension } = await fixture();
		await writeFile(
			join(extension, "secret.server.ts"),
			"export const secret = 1;",
		);
		await writeFile(
			join(extension, "index.ts"),
			'import { secret } from "./secret.server.ts"; export default () => () => secret;',
		);
		await expect(compileExtension(join(extension, "index.ts"))).rejects.toThrow(
			/server-only module cannot be imported into the client/,
		);
	});

	it("retains the last-known-good runtime after a failed local reload", async () => {
		const { root, extension } = await fixture();
		const host = makeHost(root);
		await host.start();
		await host.execute({
			_tag: "install",
			source: { _tag: "directory", path: extension },
			grantedCapabilities: ["rpc"],
		});
		await host.execute({ _tag: "set-global-enabled", enabled: true });
		await writeFile(join(extension, "index.ts"), "export default function (");
		await expect(
			host.execute({ _tag: "reload", id: "test-extension" }),
		).rejects.toMatchObject({ code: "startup-failed" });
		expect(await host.invoke("test-extension", "echo", "still-good")).toBe(
			"still-good",
		);
		const persisted = JSON.parse(
			await readFile(join(root, "host", "extensions.json"), "utf8"),
		);
		expect(persisted.extensions["test-extension"].manifest.version).toBe(
			"1.0.0",
		);
		await host.stop();

		const restarted = makeHost(root);
		await restarted.start();
		expect(
			await restarted.invoke("test-extension", "echo", "after-restart"),
		).toBe("after-restart");
		await restarted.stop();
	});

	it("discovers and drives a namespaced extension provider over IPC", async () => {
		const { root, extension } = await fixture();
		await writeFile(
			join(extension, "zuse-extension.json"),
			JSON.stringify(manifest(["providers"], ["provider"])),
		);
		await writeFile(
			join(extension, "index.ts"),
			`export default function setup(extension) {
  if (extension.target === "server") {
    extension.addProvider({
      id: "test-extension.agent",
      displayName: "Fixture Agent",
      authentication: { kind: "none" },
      capabilities: ["resume"],
      models: [{ id: "fixture-1", label: "Fixture 1", defaultModel: true }]
    }, {
      probe: async () => ({ available: true, authenticated: true }),
      start: async (input) => extension.emitProviderEvent(input.sessionId, { _tag: "Started", cursor: "fixture-cursor" }),
      send: async (sessionId, text) => extension.emitProviderEvent(sessionId, { _tag: "AssistantDelta", text }),
      interrupt: async () => {},
      close: async () => {}
    });
  }
  return () => {};
}`,
		);
		const host = makeHost(root);
		await host.start();
		await host.execute({
			_tag: "install",
			source: { _tag: "directory", path: extension },
			grantedCapabilities: ["providers"],
		});
		await host.execute({ _tag: "set-global-enabled", enabled: true });
		expect(host.providerDescriptors()).toMatchObject([
			{ id: "test-extension.agent", displayName: "Fixture Agent" },
		]);
		const event = new Promise<unknown>((resolve) => {
			const unsubscribe = host.subscribeProviderEvents((sessionId, value) => {
				if (sessionId !== "session-1") return;
				unsubscribe();
				resolve(value);
			});
		});
		await host.invokeProvider("test-extension.agent", "start", {
			input: {
				sessionId: "session-1",
				projectId: "project-1",
				cwd: extension,
				model: "fixture-1",
				resumeCursor: null,
				forkFromResume: false,
				permissionMode: "default",
				modelOptions: {},
			},
		});
		expect(await event).toEqual({
			_tag: "Started",
			cursor: "fixture-cursor",
		});
		await expect(
			host.execute({ _tag: "reload", id: "test-extension" }),
		).rejects.toMatchObject({ code: "busy" });
		await host.execute({ _tag: "disable", id: "test-extension" });
		expect(host.providerDescriptors()).toEqual([]);
		await host.execute({
			_tag: "remove",
			id: "test-extension",
			deleteData: true,
		});
		expect(host.snapshot().knownProviders).toMatchObject([
			{ id: "test-extension.agent", displayName: "Fixture Agent" },
		]);
		await host.stop();
		const restored = makeHost(root);
		await restored.start();
		expect(restored.snapshot().knownProviders).toMatchObject([
			{ displayName: "Fixture Agent" },
		]);
		await restored.stop();
	});

	it("rejects provider IDs that are reserved or outside the extension namespace", async () => {
		const { root, extension } = await fixture();
		await writeFile(
			join(extension, "zuse-extension.json"),
			JSON.stringify(manifest(["providers"], ["provider"])),
		);
		await writeFile(
			join(extension, "index.ts"),
			`export default function setup(extension) {
  if (extension.target === "server") extension.addProvider({
    id: "claude", displayName: "Shadow", authentication: { kind: "none" },
    capabilities: [], models: [{ id: "one", label: "One" }]
  }, { probe: async () => ({ available: true, authenticated: true }), start: async () => {}, send: async () => {}, interrupt: async () => {}, close: async () => {} });
  return () => {};
}`,
		);
		const host = makeHost(root);
		await host.start();
		await expect(
			host.execute({
				_tag: "install",
				source: { _tag: "directory", path: extension },
				grantedCapabilities: ["providers"],
			}),
		).rejects.toMatchObject({ code: "startup-failed" });
		await host.stop();
	});
});

describe("marketplace verification", () => {
	it("accepts an exact signed catalog and rejects signature or payload tampering", () => {
		const { publicKey, privateKey } = generateKeyPairSync("ed25519");
		const catalogBytes = Buffer.from(
			JSON.stringify({
				schemaVersion: 1,
				generatedAt: "2026-08-27T00:00:00.000Z",
				entries: [],
			}),
		);
		const signatureBase64 = sign(null, catalogBytes, privateKey).toString(
			"base64",
		);
		const publicKeyPem = publicKey
			.export({
				type: "spki",
				format: "pem",
			})
			.toString();

		expect(
			verifyMarketplaceCatalog({
				catalogBytes,
				signatureBase64,
				publicKeyPem,
			}),
		).toMatchObject({ schemaVersion: 1, entries: [] });
		expect(() =>
			verifyMarketplaceCatalog({
				catalogBytes: Buffer.from(`${catalogBytes.toString()} `),
				signatureBase64,
				publicKeyPem,
			}),
		).toThrow(/signature is invalid/);
		expect(() =>
			verifyMarketplaceCatalog({
				catalogBytes,
				signatureBase64: Buffer.alloc(64).toString("base64"),
				publicKeyPem,
			}),
		).toThrow(/signature is invalid/);
	});
});
