import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Boxd } from "@boxd-sh/sdk/web";
import { Effect, Redacted } from "effect";
import { expect, test } from "vitest";
import { makeBoxdSandboxProvider } from "../../src/boxd.ts";

const apiKey = process.env.BOXD_API_KEY;
const template = process.env.BOXD_TEMPLATE_SNAPSHOT;
const bundle = process.env.BOXD_PREPARED_RUNTIME_BUNDLE;
const org = process.env.BOXD_ORG;

// Requires a newly built cloud bundle. Never updates the shared template.
// Per-key comparison is essential: a combined fingerprint hides a duplicated
// application key when another key (such as the separately generated SSH key) differs.
test.skipIf(!apiKey || !template || !bundle)(
	"Boxd prepared clones use fresh application and SSH keys",
	{ timeout: 600_000 },
	async () => {
		if (!apiKey || !template || !bundle)
			throw new Error("live configuration missing");
		const client = new Boxd({
			apiKey,
			baseURL: "https://boxd.sh:9443",
			timeout: 60_000,
			maxRetries: 1,
		});
		const adapter = makeBoxdSandboxProvider(
			{
				apiKey: Redacted.make(apiKey),
				org,
				templateSnapshot: template,
				templateVersion: "prepared-verification",
			},
			client,
		);
		const prepare = adapter.prepareWorkspaceSnapshot;
		const activate = adapter.startWorkspaceRuntime;
		if (!prepare || !activate) throw new Error("prepared capability missing");
		const ids = new Set<string>();
		const snapshots = new Set<string>();
		const runId = randomUUID().slice(0, 8);
		const run = <A, E>(effect: Effect.Effect<A, E>) =>
			Effect.runPromise(effect);
		const exec = async (id: string, command: string) => {
			const result = await client.machines.exec(id, {
				command,
				timeout: 60_000,
			});
			if (result.exitCode !== 0)
				throw new Error("live guest verification failed");
			return result.stdout.trim();
		};
		const files = await Promise.all(
			["workspace-bootstrap.sh", "workspace-repository.sh"].map(
				async (name) => ({
					path: `/var/lib/zuse/project-build/${name}`,
					contents: await readFile(
						new URL(
							`../../../../infra/cloud-sandboxes/${name}`,
							import.meta.url,
						),
						"utf8",
					),
				}),
			),
		);
		const bootstrap = files[0];
		if (!bootstrap) throw new Error("bootstrap missing");
		const allocate = async (snapshot?: string) => {
			const machine = await run(
				(snapshot ? adapter.fork : adapter.create)({
					sandboxId: randomUUID(),
					providerLabel: `zuse-prepared-test-${runId}-${randomUUID().slice(0, 6)}`,
					snapshotId: snapshot ?? template,
					deferWorkspaceReadiness: snapshot !== undefined,
					timeoutSeconds: 600,
					onTimeout: "terminate",
					network: { kind: "open" },
					env: {},
				}),
			);
			ids.add(machine.providerSandboxId);
			return machine.providerSandboxId;
		};
		const failures: unknown[] = [];
		try {
			const source = await allocate();
			await client.machines.files.upload(
				source,
				"/tmp/prepared-runtime.mjs",
				await readFile(bundle),
			);
			await exec(
				source,
				"sudo -n mkdir -p /opt/zuse/current && sudo -n cp /tmp/prepared-runtime.mjs /opt/zuse/current/bin.mjs && if [ ! -e /opt/zuse/current/node_modules ]; then sudo -n ln -s /usr/local/lib/zuse-serve/node_modules /opt/zuse/current/node_modules; fi; sudo -n install -d -m 0700 -o zuse -g zuse /var/lib/zuse/project-build /var/lib/zuse/workspace /home/zuse/prepared-project",
			);
			await exec(
				source,
				"sudo -n -u zuse git init -b main /home/zuse/prepared-project && sudo -n -u zuse git -C /home/zuse/prepared-project -c user.name=fixture -c user.email=fixture@example.test commit --allow-empty -m fixture && sudo -n -u zuse git -C /home/zuse/prepared-project remote add origin https://example.test/fixture.git",
			);
			// Records public keys only; deliberately refuses real enrollment.
			const observer = `require('node:http').createServer((req,res)=>{let bytes='';req.on('data',c=>bytes+=c);req.on('end',()=>{if(req.url.includes('bootstrap')){const body=JSON.parse(bytes);require('node:fs').writeFileSync('/tmp/prepared-enrollment.json',JSON.stringify({credentialPublicJwk:body.credentialPublicJwk,signingPublicJwk:body.signingPublicJwk}));}res.writeHead(503);res.end('{}');});}).listen(48080,'127.0.0.1');`;
			await run(
				adapter.startProcess(source, {
					command: "node",
					args: ["-e", observer],
					tag: "prepared-observer",
					user: "zuse",
				}),
			);
			await run(prepare(source, files));
			await exec(
				source,
				"sudo -n test ! -f /var/lib/zuse/user-data/zuse.sqlite && test ! -f /tmp/prepared-enrollment.json",
			);
			const name = `prepared-test-${runId}`;
			snapshots.add(`zuse-${name}`);
			const snapshot = await run(adapter.snapshot(source, name));
			snapshots.add(snapshot);
			const keySets = [new Set<string>(), new Set<string>(), new Set<string>()];
			for (let index = 0; index < 3; index++) {
				const started = performance.now();
				const id = await allocate(snapshot);
				await run(
					activate(
						id,
						{
							command: "/bin/bash",
							args: [bootstrap.path],
							tag: "zuse-runtime",
							user: "zuse",
							env: {
								ZUSE_CLOUD_WORKSPACE_ID: `prepared-${runId}-${index}`,
								ZUSE_RUNTIME_GENERATION: "1",
								ZUSE_GATEWAY_EPOCH: "1",
								ZUSE_RUNTIME_BOOT_TOKEN: randomUUID(),
								ZUSE_CLOUD_WORKSPACE_ROOT: "/home/zuse/prepared-project",
								ZUSE_API_URL: "http://127.0.0.1:48080",
								ZUSE_BASE_REF: "main",
								ZUSE_BRANCH: `test-${index}`,
								ZUSE_REPOSITORY_URL: "https://example.test/fixture.git",
							},
						},
						files,
					),
				);
				await exec(
					id,
					"for i in $(seq 1 150); do test -s /tmp/prepared-enrollment.json && exit 0; sleep 0.1; done; exit 1",
				);
				console.info(
					"[boxd-prepared-verification] allocation-to-enrollment-ms",
					Math.round(performance.now() - started),
				);
				const publicKeys = JSON.parse(
					await exec(id, "cat /tmp/prepared-enrollment.json"),
				) as { credentialPublicJwk: string; signingPublicJwk: string };
				const ssh = await exec(
					id,
					"sudo -n cat /home/zuse/.ssh/host_ed25519_key.pub",
				);
				[
					publicKeys.credentialPublicJwk,
					publicKeys.signingPublicJwk,
					ssh,
				].forEach((key, column) => {
					keySets[column]?.add(createHash("sha256").update(key).digest("hex"));
				});
				await exec(
					id,
					"sudo -n test -f /var/lib/zuse/user-data/zuse.sqlite && sudo -n test -f /var/lib/zuse/workspace/repository-ready",
				);
			}
			for (const keys of keySets) expect(keys.size).toBe(3);
		} catch (error) {
			failures.push(error);
		} finally {
			for (const id of ids)
				try {
					await client.machines.delete(id);
				} catch (error) {
					failures.push(error);
				}
			for (const snapshot of snapshots)
				try {
					await client.snapshots.delete(snapshot, { org });
				} catch (error) {
					failures.push(error);
				}
			await client.close();
		}
		if (failures.length)
			throw new AggregateError(
				failures,
				"Prepared runtime verification or cleanup failed",
			);
	},
);
