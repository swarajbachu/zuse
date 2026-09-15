import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, it, vi } from "vitest";
import { ExtensionHost } from "../../src/host.ts";

it("loads a command-only ACP extension, streams through the host, and kills agents when its worker crashes", async () => {
	const root = await mkdtemp(join(tmpdir(), "zuse-acp-host-"));
	const source = join(root, "source");
	await mkdir(source);
	const pidFile = join(root, "agent.pid");
	const fixture = resolve("packages/agents/test/fixtures/extension-acp.mjs");
	await writeFile(
		join(source, "zuse-extension.json"),
		JSON.stringify({
			schemaVersion: 1,
			id: "fixture-acp",
			name: "ACP fixture",
			description: "Test ACP registration",
			version: "1.0.0",
			server: "index.ts",
			zuseApi: "^1.2.0",
			contributions: ["provider"],
			capabilities: ["providers", "process", "rpc"],
			publisher: { name: "Tests" },
		}),
	);
	await writeFile(
		join(source, "index.ts"),
		`
 import {defineRpc} from '@zuse/extension-sdk'; import {Schema} from 'effect';
 export default function setup(e) {
 e.handle(defineRpc({name:'crash',input:Schema.String,output:Schema.String}),()=>{process.kill(process.pid,'SIGKILL');return '';});
 return e.addAcpProvider({id:'fixture-acp.agent',displayName:'Fixture ACP',command:${JSON.stringify([process.execPath, fixture])},env:{ZUSE_ACP_TEST_PID:${JSON.stringify(pidFile)}}});
 }`,
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
			grantedCapabilities: ["providers", "process", "rpc"],
		});
		expect(host.providerDescriptors()).toMatchObject([
			{ id: "fixture-acp.agent", models: [{ id: "default" }] },
		]);
		const events: unknown[] = [];
		const unsubscribe = host.subscribeProviderEvents((_id, event) =>
			events.push(event),
		);
		await host.invokeProvider("fixture-acp.agent", "start", {
			input: {
				sessionId: "s1",
				projectId: "p1",
				cwd: root,
				model: "default",
				resumeCursor: null,
				forkFromResume: false,
				permissionMode: "default",
				modelOptions: {},
			},
		});
		await host.invokeProvider("fixture-acp.agent", "send", {
			sessionId: "s1",
			text: "world",
		});
		await vi.waitFor(() =>
			expect(events).toContainEqual(
				expect.objectContaining({
					_tag: "AssistantMessage",
					text: "Hello world",
				}),
			),
		);
		await expect(
			host.execute({ _tag: "reload", id: "fixture-acp" }),
		).rejects.toMatchObject({ code: "busy" });
		const pid = Number(await readFile(pidFile, "utf8"));
		expect(pid).toBeGreaterThan(0);
		await expect(host.invoke("fixture-acp", "crash", "")).rejects.toThrow();
		await vi.waitFor(() => expect(() => process.kill(pid, 0)).toThrow(), {
			timeout: 5000,
		});
		unsubscribe();
		await host.execute({ _tag: "disable", id: "fixture-acp" });
		expect(host.providerDescriptors()).toEqual([]);
	} finally {
		await host.stop();
		await rm(root, { recursive: true, force: true });
	}
}, 20000);
