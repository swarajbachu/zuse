import { Effect, Redacted } from "effect";
import { describe, expect, test } from "vitest";
import { makeBoxdSandboxProvider } from "../../src/boxd.ts";
import type { ProviderSandbox } from "../../src/index.ts";

// Live verification against production boxd (boxd.sh). Runs only when
// BOXD_API_KEY and BOXD_TEMPLATE_SNAPSHOT are set; the template snapshot must
// be a published zuse base template (infra/cloud-sandboxes/boxd-publish.sh)
// because the runtime checks exercise the installed CLI as the zuse user.
// Costs a few cents of machine time per run. BOXD_ORG selects the org the
// key is fenced to.
const apiKey = process.env.BOXD_API_KEY;
const templateSnapshot = process.env.BOXD_TEMPLATE_SNAPSHOT;
const org = process.env.BOXD_ORG;

const LIVE_TIMEOUT_SECONDS = 600;

const pollUntil = async <A>(
	run: () => Promise<A>,
	predicate: (value: A) => boolean,
	attempts = 30,
	delayMs = 2_000,
): Promise<A> => {
	let value = await run();
	for (let attempt = 0; attempt < attempts && !predicate(value); attempt++) {
		await new Promise((resolve) => setTimeout(resolve, delayMs));
		value = await run();
	}
	return value;
};

// A minimal WebSocket echo server on Node's http module: the SSH bridge and
// the desktop's live connection both ride WebSockets through the proxy.
const WS_ECHO_SERVER = `
const http = require('node:http'); const crypto = require('node:crypto');
const server = http.createServer((request, response) => { response.writeHead(200, { 'content-type': 'text/plain' }); response.end('ok'); });
server.on('upgrade', (request, socket) => {
  const accept = crypto.createHash('sha1').update(request.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  socket.write('HTTP/1.1 101 Switching Protocols\\r\\nUpgrade: websocket\\r\\nConnection: Upgrade\\r\\nSec-WebSocket-Accept: ' + accept + '\\r\\n\\r\\n');
  socket.on('data', (frame) => { if (frame.length < 6) return; const length = frame[1] & 0x7f; const mask = frame.subarray(2, 6); const payload = Buffer.from(frame.subarray(6, 6 + length).map((byte, index) => byte ^ mask[index % 4])); const body = Buffer.from('echo:' + payload); socket.write(Buffer.concat([Buffer.from([0x81, body.length]), body])); });
});
server.listen(47837, '127.0.0.1');
`;

describe.skipIf(apiKey === undefined || templateSnapshot === undefined)(
	"boxd live lifecycle",
	() => {
		test("drives the full adapter lifecycle against production", {
			timeout: 30 * 60_000,
		}, async () => {
			const adapter = makeBoxdSandboxProvider({
				// biome-ignore lint/style/noNonNullAssertion: guarded by skipIf
				apiKey: Redacted.make(apiKey!),
				// biome-ignore lint/style/noNonNullAssertion: guarded by skipIf
				templateSnapshot: templateSnapshot!,
				templateVersion: "live-test",
				org,
			});
			const runId = Date.now().toString(36);
			const label = `zuse-live-${runId}`;
			const forkLabel = `zuse-live-fork-${runId}`;
			const createdIds: string[] = [];
			let snapshotId: string | null = null;
			const failures: unknown[] = [];
			const timings: Record<string, number> = {};
			const timed = async <A>(name: string, run: () => Promise<A>) => {
				const started = performance.now();
				const value = await run();
				timings[name] = Math.round(performance.now() - started);
				return value;
			};
			const canary = (id: string, path: string) =>
				pollUntil(
					() => Effect.runPromise(adapter.pathExists(id, path)),
					(value) => value,
				);

			try {
				const created = await timed("create", () =>
					Effect.runPromise(
						adapter.create({
							sandboxId: `live_${runId}`,
							providerLabel: label,
							timeoutSeconds: LIVE_TIMEOUT_SECONDS,
							env: {},
							network: { kind: "open" },
							onTimeout: "pause",
						}),
					),
				);
				createdIds.push(created.providerSandboxId);
				expect(created.state).toBe("running");

				// Egress and the runtime user, straight after creation.
				await Effect.runPromise(
					adapter.startProcess(created.providerSandboxId, {
						command: "/bin/bash",
						args: [
							"-c",
							"curl -sf --max-time 10 https://example.com >/dev/null && touch /tmp/zuse-canary-online",
						],
						user: "zuse",
					}),
				);
				expect(
					await canary(created.providerSandboxId, "/tmp/zuse-canary-online"),
				).toBe(true);

				const inspected = await Effect.runPromise(
					adapter.inspect(created.providerSandboxId),
				);
				expect(inspected?.state).toBe("running");
				expect(inspected?.providerLabel).toBe(label);

				// The published runtime loads as its unprivileged user.
				await Effect.runPromise(
					adapter.startProcess(created.providerSandboxId, {
						command: "/bin/bash",
						args: [
							"-c",
							"/usr/local/bin/zuse --help >/tmp/zuse-runtime-smoke.log 2>&1 && touch /tmp/zuse-runtime-smoke-ok",
						],
						user: "zuse",
					}),
				);
				expect(
					await canary(created.providerSandboxId, "/tmp/zuse-runtime-smoke-ok"),
				).toBe(true);

				// A tagged (systemd) process on the runtime port, bound to loopback
				// like the real runtime, reachable over HTTPS and WebSocket.
				await Effect.runPromise(
					adapter.writeTextFile(
						created.providerSandboxId,
						"/home/zuse/ws-echo.js",
						WS_ECHO_SERVER,
						"zuse",
					),
				);
				await Effect.runPromise(
					adapter.startProcess(created.providerSandboxId, {
						command: "/usr/bin/node",
						args: ["/home/zuse/ws-echo.js"],
						user: "zuse",
						tag: "zuse-live-http",
					}),
				);
				await Effect.runPromise(
					adapter.startProcess(created.providerSandboxId, {
						command: "/bin/bash",
						args: [
							"-c",
							"for i in $(seq 1 20); do curl -sf http://127.0.0.1:47837/ >/dev/null && touch /tmp/zuse-live-local-ok && exit 0; sleep 1; done; exit 1",
						],
						user: "zuse",
					}),
				);
				expect(
					await canary(created.providerSandboxId, "/tmp/zuse-live-local-ok"),
				).toBe(true);
				const endpoint = await timed("resolveEndpoint", () =>
					Effect.runPromise(
						adapter.resolveEndpoint(created.providerSandboxId, 47_837),
					),
				);
				expect(endpoint.httpBaseUrl).toMatch(/^https:\/\/p47837\./u);
				const publicResponse = await pollUntil(
					() =>
						fetch(`${endpoint.httpBaseUrl}/?run=${runId}`).catch(
							() => new Response(null, { status: 503 }),
						),
					(response) => response.ok,
				);
				expect(publicResponse.ok).toBe(true);
				const echoed = await new Promise<string>((resolve, reject) => {
					const socket = new WebSocket(`${endpoint.wsBaseUrl}/ssh`);
					const timer = setTimeout(
						() => reject(new Error("websocket echo timed out")),
						15_000,
					);
					socket.onopen = () => socket.send("ping");
					socket.onmessage = (event) => {
						clearTimeout(timer);
						socket.close();
						resolve(String(event.data));
					};
					socket.onerror = () => {
						clearTimeout(timer);
						reject(new Error("websocket failed"));
					};
				});
				expect(echoed).toBe("echo:ping");

				// File round trip with owner-only permissions.
				await Effect.runPromise(
					adapter.writeTextFile(
						created.providerSandboxId,
						"/home/zuse/.zuse-live-file",
						"live-contents",
						"zuse",
					),
				);
				await expect(
					Effect.runPromise(
						adapter.readTextFile(
							created.providerSandboxId,
							"/home/zuse/.zuse-live-file",
						),
					),
				).resolves.toBe("live-contents");

				// Label recovery must find exactly this machine.
				const recovered = await pollUntil(
					() => Effect.runPromise(adapter.recoverByLabel(label)),
					(value): value is ProviderSandbox => value !== null,
				);
				expect(recovered?.providerSandboxId).toBe(created.providerSandboxId);

				// Hibernate, hibernate again (tolerated), wake with the runtime intact.
				await timed("pause", () =>
					Effect.runPromise(adapter.pause(created.providerSandboxId)),
				);
				const paused = await pollUntil(
					() => Effect.runPromise(adapter.inspect(created.providerSandboxId)),
					(value) => value?.state === "paused",
				);
				expect(paused?.state).toBe("paused");
				await Effect.runPromise(adapter.pause(created.providerSandboxId));
				const resumed = await timed("resume", () =>
					Effect.runPromise(
						adapter.resume(
							created.providerSandboxId,
							LIVE_TIMEOUT_SECONDS,
							"pause",
						),
					),
				);
				expect(resumed.state).toBe("running");
				// The tagged echo server survived the pause: warm resume semantics.
				await Effect.runPromise(
					adapter.startProcess(created.providerSandboxId, {
						command: "/bin/bash",
						args: [
							"-c",
							"curl -sf http://127.0.0.1:47837/ >/dev/null && touch /tmp/zuse-live-warm-ok",
						],
						user: "zuse",
					}),
				);
				expect(
					await canary(created.providerSandboxId, "/tmp/zuse-live-warm-ok"),
				).toBe(true);
				// The fenced restart path must still be able to replace it.
				await Effect.runPromise(
					adapter.replaceProcess(
						created.providerSandboxId,
						{
							tag: "zuse-live-http",
							legacyCommandMarkers: ["ws-echo.js"],
							legacyCleanup: "matching-command",
						},
						{
							command: "/bin/bash",
							args: ["-c", "touch /tmp/zuse-live-replaced-ok && sleep 300"],
							user: "zuse",
						},
					),
				);
				expect(
					await canary(created.providerSandboxId, "/tmp/zuse-live-replaced-ok"),
				).toBe(true);

				await Effect.runPromise(
					adapter.extendTimeout(
						created.providerSandboxId,
						LIVE_TIMEOUT_SECONDS,
					),
				);

				snapshotId = await timed("snapshot", () =>
					Effect.runPromise(
						adapter.snapshot(created.providerSandboxId, `live-${runId}`),
					),
				);
				expect(snapshotId).not.toBe("");

				const forked = await timed("fork", () =>
					Effect.runPromise(
						adapter.fork({
							sandboxId: `live_fork_${runId}`,
							providerLabel: forkLabel,
							snapshotId: snapshotId as string,
							timeoutSeconds: LIVE_TIMEOUT_SECONDS,
							env: {},
							network: { kind: "open" },
							onTimeout: "pause",
						}),
					),
				);
				createdIds.push(forked.providerSandboxId);
				expect(forked.state).toBe("running");
				expect(forked.providerSandboxId).not.toBe(created.providerSandboxId);
				// The fork restored the captured memory: the replaced process is
				// already running and the file written before the capture exists.
				await expect(
					Effect.runPromise(
						adapter.readTextFile(
							forked.providerSandboxId,
							"/home/zuse/.zuse-live-file",
						),
					),
				).resolves.toBe("live-contents");
				await Effect.runPromise(
					adapter.startProcess(forked.providerSandboxId, {
						command: "/bin/bash",
						args: [
							"-c",
							"curl -sf --max-time 10 https://example.com >/dev/null && touch /tmp/zuse-fork-canary-online",
						],
						user: "zuse",
					}),
				);
				expect(
					await canary(
						forked.providerSandboxId,
						"/tmp/zuse-fork-canary-online",
					),
				).toBe(true);
			} catch (cause) {
				failures.push(cause);
			} finally {
				console.info("[boxd live] timings ms", timings);
				const cleanup = createdIds.flatMap((id) => [
					() => Effect.runPromise(adapter.kill(id)),
					() => Effect.runPromise(adapter.kill(id)),
				]);
				if (snapshotId !== null) {
					const id = snapshotId;
					cleanup.push(
						() => Effect.runPromise(adapter.deleteSnapshot(id)),
						() => Effect.runPromise(adapter.deleteSnapshot(id)),
					);
				}
				for (const operation of cleanup) {
					try {
						await operation();
					} catch (cause) {
						failures.push(cause);
					}
				}
			}
			if (failures.length > 0)
				throw new AggregateError(failures, "boxd live test or cleanup failed");

			const gone = await pollUntil(
				() => Effect.runPromise(adapter.recoverByLabel(label)),
				(value) => value === null,
			);
			expect(gone).toBeNull();
		});
	},
);
