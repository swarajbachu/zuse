import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { decodeArtifact } from "../../src/artifact.ts";
import { compileExtension } from "../../src/compiler.ts";
import { ExtensionHost } from "../../src/host.ts";
import { assertApiCompatible } from "../../src/manifest.ts";
import { ProviderEventHub } from "../../src/provider-events.ts";

describe("desktop preview boundaries", () => {
	it("ends an overflowing stream visibly and releases its session", async () => {
		const hub = new ProviderEventHub();
		hub.open("session");
		for (let i = 0; i < 257; i++)
			hub.push("session", { _tag: "TextDelta", text: "a" });
		const events = [];
		for await (const event of hub.stream("session")) events.push(event);
		expect(events).toEqual([
			{ _tag: "Error", message: expect.stringContaining("overflowed") },
			{ _tag: "Status", status: "error" },
		]);
		expect(() => hub.open("session")).not.toThrow();
		hub.stop();
	});
	it("checks semantic ranges instead of string prefixes", () => {
		for (const range of ["^1.0.0", "^1.1.0", ">=0.9.0 <2", "1.x"])
			expect(() => assertApiCompatible(range)).not.toThrow();
		for (const range of ["^1.2.0", "^2.0.0", "banana", "1.0.0-beta.1"])
			expect(() => assertApiCompatible(range)).toThrow();
	});
	it("rejects archive bytes and invalid data envelopes without extracting files", () => {
		for (const data of [
			"../escape",
			'{"schemaVersion":1,"compiled":{"../../outside":"x"}}',
			'{"schemaVersion":2}',
		])
			expect(() => decodeArtifact(Buffer.from(data))).toThrow();
	});
	it("rejects runtime modules unavailable on the selected target", async () => {
		const root = await mkdtemp(join(tmpdir(), "extension-boundary-"));
		try {
			await writeFile(
				join(root, "index.ts"),
				'import { x } from "@zuse/extension-sdk/host"; export default () => x;',
			);
			await expect(
				compileExtension({ client: join(root, "index.ts") }),
			).rejects.toThrow("not provided");
			await writeFile(
				join(root, "index.ts"),
				'import { Effect } from "effect"; export default () => Effect.succeed(1);',
			);
			await expect(
				compileExtension({ server: join(root, "index.ts") }),
			).rejects.toThrow("No matching export");
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
	it("runs all three independently with isolated results and immutable snapshots", async () => {
		const root = await mkdtemp(join(tmpdir(), "extension-preview-"));
		const workspace = join(root, "workspace");
		await mkdir(workspace);
		const host = new ExtensionHost({
			rootDirectory: join(root, "host"),
			secretStore: {
				get: async () => null,
				set: async () => {},
				delete: async () => {},
			},
		});
		try {
			await writeFile(
				join(workspace, "report.xml"),
				'<testsuite name="checkout"><testcase name="payment"><failure>declined</failure></testcase></testsuite>',
			);
			await writeFile(join(workspace, "notes.md"), "# Deploy\nVerify tests.");
			await writeFile(join(workspace, "code.ts"), "// TODO: add refunds");
			await host.start();
			await host.execute({ _tag: "set-global-enabled", enabled: true });
			for (const id of ["test-reports", "project-playbook", "code-follow-ups"])
				await host.execute({
					_tag: "install",
					source: {
						_tag: "directory",
						path: fileURLToPath(
							new URL(`../../../../extensions/${id}`, import.meta.url),
						),
					},
					grantedCapabilities: [
						"ui",
						"attachments",
						"rpc",
						"filesystem",
						...(id === "code-follow-ups" ? ["commands" as const] : []),
					],
				});
			const context = {
				projectId: "project",
				workspacePath: workspace,
				sessionId: null,
			};
			const read = (id: string, path: string) =>
				host.invoke(
					id,
					"workspace-tool",
					{ action: "read", path, query: "", cursor: 0 },
					context,
				);
			const report = await read("test-reports", "report.xml");
			expect(report).toMatchObject({
				items: [
					{
						title: "FAILED: payment",
						text: expect.stringContaining("declined"),
					},
				],
			});
			expect(await read("project-playbook", "notes.md")).toMatchObject({
				items: [{ title: "Deploy" }],
			});
			expect(
				await host.invoke(
					"code-follow-ups",
					"workspace-tool",
					{ action: "scan", path: "", query: "", cursor: 0 },
					context,
				),
			).toMatchObject({ items: [{ title: "TODO: add refunds" }] });
			await writeFile(join(workspace, "report.xml"), "<testsuite/>");
			expect(report).toMatchObject({
				items: [{ text: expect.stringContaining("declined") }],
			});
			await host.execute({ _tag: "disable", id: "project-playbook" });
			expect(await read("test-reports", "report.xml")).toMatchObject({
				items: [],
			});
		} finally {
			await host.stop();
			await rm(root, { recursive: true, force: true });
		}
	}, 20_000);
});

it("cancels an in-flight backend invocation and remains usable", async () => {
	const root = await mkdtemp(join(tmpdir(), "extension-cancel-"));
	const source = join(root, "source");
	await mkdir(source);
	const manifest = {
		schemaVersion: 1,
		id: "cancel-test",
		name: "Cancellation",
		description: "fixture",
		version: "0.1.0",
		server: "index.ts",
		zuseApi: "^1.0.0",
		capabilities: ["rpc"],
		contributions: [],
		publisher: { name: "Tests" },
	};
	await writeFile(
		join(source, "zuse-extension.json"),
		JSON.stringify(manifest),
	);
	await writeFile(
		join(source, "index.ts"),
		`import {Schema} from 'effect';import {defineRpc} from '@zuse/extension-sdk';export default function(e){e.handle(defineRpc({name:'wait',input:Schema.Boolean,output:Schema.String}),async(wait,context)=>{if(wait)await new Promise((resolve,reject)=>context.signal.addEventListener('abort',()=>reject(new Error('cancelled')),{once:true}));return 'ok';});return ()=>{};}`,
	);
	const host = new ExtensionHost({
		rootDirectory: join(root, "host"),
		secretStore: {
			get: async () => null,
			set: async () => {},
			delete: async () => {},
		},
	});
	try {
		await host.start();
		await host.execute({ _tag: "set-global-enabled", enabled: true });
		await host.execute({
			_tag: "install",
			source: { _tag: "directory", path: source },
			grantedCapabilities: ["rpc"],
		});
		const invocation = host.invoke(
			"cancel-test",
			"wait",
			true,
			undefined,
			"request",
		);
		const rejected = expect(invocation).rejects.toMatchObject({
			code: "rpc-failed",
			reason: expect.stringContaining("cancelled"),
		});
		host.cancel("cancel-test", "request");
		await rejected;
		expect(await host.invoke("cancel-test", "wait", false)).toBe("ok");
	} finally {
		await host.stop();
		await rm(root, { recursive: true, force: true });
	}
});

it("bounds asynchronous startup and rejects secret mutations during preparation", async () => {
	const { startExtensionProcess } = await import("../../src/runtime.ts");
	const root = await mkdtemp(join(tmpdir(), "extension-startup-"));
	let writes = 0;
	const options = {
		id: "startup-test",
		storagePath: join(root, "state.json"),
		capabilities: ["credentials"] as const,
		secretStore: {
			get: async () => null,
			set: async () => {
				writes++;
			},
			delete: async () => {
				writes++;
			},
		},
		now: () => new Date(),
		onExit: () => {},
	};
	try {
		await expect(
			startExtensionProcess({
				...options,
				startupTimeoutMs: 1000,
				compiled: {
					clientBundle: "",
					clientCss: "",
					serverBundle:
						"(function(){return {default:async()=>new Promise(()=>{})}})",
				},
			}),
		).rejects.toThrow("did not initialize");
		await expect(
			startExtensionProcess({
				...options,
				compiled: {
					clientBundle: "",
					clientCss: "",
					serverBundle:
						'(function(){return {default:async(e)=>{await e.secrets.set("key","value");return ()=>{};}}})',
				},
			}),
		).rejects.toThrow();
		expect(writes).toBe(0);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
}, 10_000);

it("loads JSX through the provided runtime rather than an implicit React global", async () => {
	const root = await mkdtemp(join(tmpdir(), "extension-jsx-"));
	try {
		await writeFile(
			join(root, "client.tsx"),
			"export default function View(){return <strong>Ready</strong>}",
		);
		const compiled = await compileExtension({
			client: join(root, "client.tsx"),
		});
		// biome-ignore lint/security/noGlobalEval: exercise the same trusted factory boundary as the renderer
		const factory = globalThis.eval(compiled.clientBundle);
		const result = factory((name: string) => {
			if (name === "react/jsx-runtime")
				return { jsx: (type: string, props: unknown) => ({ type, props }) };
			throw new Error(`Unexpected runtime import ${name}`);
		});
		expect(result.default()).toEqual({
			type: "strong",
			props: { children: "Ready" },
		});
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

it("installs precompiled catalog data, rejects tampering, and retains installed tools offline", async () => {
	const { generateKeyPairSync, sign } = await import("node:crypto");
	const { sha256 } = await import("../../src/marketplace.ts");
	const { readExtensionManifest, compileEntries } = await import(
		"../../src/manifest.ts"
	);
	const { privateKey, publicKey } = generateKeyPairSync("ed25519");
	const manifest = await readExtensionManifest(
		fileURLToPath(
			new URL("../../../../extensions/project-playbook", import.meta.url),
		),
	);
	const compiled = await compileExtension(
		compileEntries(
			fileURLToPath(
				new URL("../../../../extensions/project-playbook", import.meta.url),
			),
			manifest,
		),
	);
	const artifact = Buffer.from(
		JSON.stringify({ schemaVersion: 1, manifest, compiled }),
	);
	const catalog = Buffer.from(
		JSON.stringify({
			schemaVersion: 1,
			generatedAt: new Date().toISOString(),
			entries: [
				{
					manifest,
					commit: "a".repeat(40),
					sha256: sha256(artifact),
					archiveUrl: "https://catalog.test/artifact.json",
					changelog: "Fixture",
				},
			],
		}),
	);
	const signature = sign(null, catalog, privateKey).toString("base64");
	let offline = false;
	let tampered = true;
	const root = await mkdtemp(join(tmpdir(), "extension-precompiled-"));
	const host = new ExtensionHost({
		rootDirectory: root,
		secretStore: {
			get: async () => null,
			set: async () => {},
			delete: async () => {},
		},
		marketplace: {
			catalogUrl: "https://catalog.test/catalog.json",
			signatureUrl: "https://catalog.test/catalog.sig",
			publicKeyPem: publicKey
				.export({ type: "spki", format: "pem" })
				.toString(),
		},
		fetch: async (url) => {
			if (offline) throw new Error("Offline");
			return new Response(
				String(url).endsWith(".sig")
					? signature
					: String(url).endsWith("artifact.json")
						? tampered
							? Buffer.from("tampered")
							: artifact
						: catalog,
			);
		},
	});
	try {
		await host.start();
		const install = () =>
			host.execute({
				_tag: "install",
				source: { _tag: "marketplace", catalogId: manifest.id },
				grantedCapabilities: manifest.capabilities,
			});
		await expect(install()).rejects.toThrow();
		expect(host.snapshot().items).toHaveLength(0);
		tampered = false;
		await install();
		expect(host.snapshot().items).toHaveLength(1);
		offline = true;
		await expect(host.marketplace(true)).rejects.toThrow();
		expect(host.snapshot().items[0]?.manifest.id).toBe(manifest.id);
	} finally {
		await host.stop();
		await rm(root, { recursive: true, force: true });
	}
});
