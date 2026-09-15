import { Effect, Redacted } from "effect";
import { describe, expect, test } from "vitest";
import { makeBoxSandboxProvider } from "../../src/box.ts";
import type { ProviderSandbox } from "../../src/index.ts";

// Live verification against production Box (box.ascii.dev). Runs only when
// BOX_API_KEY and BOX_TEMPLATE_SNAPSHOT are set; the template snapshot must
// be a published zuse base template (see infra/cloud-sandboxes) because the
// create path verifies the template-baked quarantine firewall. Costs a few
// cents of machine time per run. This is the standing gate for the in-guest
// quarantine amendment: it proves a fresh box boots with egress denied and
// only opens through setNetwork.
const apiKey = process.env.BOX_API_KEY;
const templateSnapshot = process.env.BOX_TEMPLATE_SNAPSHOT;

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

describe.skipIf(apiKey === undefined || templateSnapshot === undefined)(
	"Box live lifecycle",
	() => {
		test("drives the full adapter lifecycle against production", {
			timeout: 45 * 60_000,
		}, async () => {
			const adapter = makeBoxSandboxProvider({
				// biome-ignore lint/style/noNonNullAssertion: guarded by skipIf
				apiKey: Redacted.make(apiKey!),
				// biome-ignore lint/style/noNonNullAssertion: guarded by skipIf
				templateSnapshot: templateSnapshot!,
				templateVersion: "live-test",
			});
			const runId = Date.now().toString(36);
			const label = `zuse-live-${runId}`;
			const forkLabel = `zuse-live-fork-${runId}`;
			const createdIds: string[] = [];
			let snapshotId: string | null = null;
			const failures: unknown[] = [];

			try {
				// create — boots quarantined; the adapter verifies the firewall
				const created = await Effect.runPromise(
					adapter.create({
						sandboxId: `live_${runId}`,
						providerLabel: label,
						timeoutSeconds: LIVE_TIMEOUT_SECONDS,
						env: { ZUSE_LIVE_TEST: runId },
						network: { kind: "quarantined" },
						onTimeout: "pause",
					}),
				);
				createdIds.push(created.providerSandboxId);
				expect(created.state).toBe("running");

				// quarantine canary: an external fetch from inside must fail while
				// quarantined and succeed once the network opens.
				const canary = () =>
					Effect.runPromise(
						adapter.pathExists(
							created.providerSandboxId,
							"/tmp/zuse-canary-online",
						),
					);
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
				await new Promise((resolve) => setTimeout(resolve, 15_000));
				expect(await canary()).toBe(false);

				// inspect
				const inspected = await Effect.runPromise(
					adapter.inspect(created.providerSandboxId),
				);
				expect(inspected?.state).toBe("running");
				expect(inspected?.providerLabel).toBe(label);

				// Validate the published runtime as its actual unprivileged user.
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
				const runtimeLoads = await pollUntil(
					() =>
						Effect.runPromise(
							adapter.pathExists(
								created.providerSandboxId,
								"/tmp/zuse-runtime-smoke-ok",
							),
						),
					(value) => value,
				);
				expect(runtimeLoads).toBe(true);

				// open the network in one call, then the canary must go green
				await Effect.runPromise(
					adapter.setNetwork(created.providerSandboxId, { kind: "open" }),
				);
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
				const online = await pollUntil(canary, (value) => value);
				expect(online).toBe(true);

				// hosted-port reachability over the stable subdomain URL
				await Effect.runPromise(
					adapter.startProcess(created.providerSandboxId, {
						command: "/bin/bash",
						args: [
							"-c",
							"mkdir -p /tmp/zuse-live-http && printf ok > /tmp/zuse-live-http/index.html && exec python3 -m http.server 47837 --bind 127.0.0.1 --directory /tmp/zuse-live-http",
						],
						user: "zuse",
						tag: "zuse-live-http",
					}),
				);
				const localIndex = await pollUntil(
					() =>
						Effect.runPromise(
							adapter.pathExists(
								created.providerSandboxId,
								"/tmp/zuse-live-http/index.html",
							),
						),
					(value) => value,
				);
				expect(localIndex).toBe(true);
				await Effect.runPromise(
					adapter.startProcess(created.providerSandboxId, {
						command: "/bin/bash",
						args: [
							"-c",
							"curl -sf http://127.0.0.1:47837/index.html >/dev/null && touch /tmp/zuse-live-http/local-ok",
						],
						user: "zuse",
					}),
				);
				const localReachable = await pollUntil(
					() =>
						Effect.runPromise(
							adapter.pathExists(
								created.providerSandboxId,
								"/tmp/zuse-live-http/local-ok",
							),
						),
					(value) => value,
				);
				expect(localReachable).toBe(true);
				const endpoint = await Effect.runPromise(
					adapter.resolveEndpoint(created.providerSandboxId, 47_837),
				);
				const publicResponse = await pollUntil(
					() =>
						fetch(`${endpoint.httpBaseUrl}/index.html?run=${runId}`).catch(
							() => new Response(null, { status: 503 }),
						),
					(response) => response.ok,
				);
				expect(publicResponse.ok).toBe(true);
				// NOTE: WebSocket support on hosted ports is a hard production
				// gate; it is exercised end-to-end by the staging SSH bridge
				// checklist because it needs the full workspace runtime.

				// file round trip with owner-only permissions
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

				// recoverByLabel — name matching must find exactly this box
				const recovered = await pollUntil(
					() => Effect.runPromise(adapter.recoverByLabel(label)),
					(value): value is ProviderSandbox => value !== null,
				);
				expect(recovered?.providerSandboxId).toBe(created.providerSandboxId);

				// pause (archive), then pause again (must be tolerated)
				await Effect.runPromise(adapter.pause(created.providerSandboxId));
				const paused = await pollUntil(
					() => Effect.runPromise(adapter.inspect(created.providerSandboxId)),
					(value) => value?.state === "paused",
				);
				expect(paused?.state).toBe("paused");
				await Effect.runPromise(adapter.pause(created.providerSandboxId));

				// resume restores the same box id on fresh hardware
				const resumed = await Effect.runPromise(
					adapter.resume(
						created.providerSandboxId,
						LIVE_TIMEOUT_SECONDS,
						"pause",
					),
				);
				expect(resumed.state).toBe("running");

				// extend timeout
				await Effect.runPromise(
					adapter.extendTimeout(
						created.providerSandboxId,
						LIVE_TIMEOUT_SECONDS,
					),
				);

				// named snapshot
				snapshotId = await Effect.runPromise(
					adapter.snapshot(created.providerSandboxId, `live-${runId}`),
				);
				expect(snapshotId).not.toBe("");

				// fork from the snapshot — boots quarantined by construction
				const forked = await Effect.runPromise(
					adapter.fork({
						sandboxId: `live_fork_${runId}`,
						providerLabel: forkLabel,
						snapshotId,
						timeoutSeconds: LIVE_TIMEOUT_SECONDS,
						env: { ZUSE_LIVE_TEST: runId },
						network: { kind: "quarantined" },
						onTimeout: "pause",
					}),
				);
				createdIds.push(forked.providerSandboxId);
				expect(forked.state).toBe("running");
				expect(forked.providerSandboxId).not.toBe(created.providerSandboxId);

				// the fork inherited the parent's open-network disk state, but must
				// still boot behind the firewall: prove egress is denied again.
				await Effect.runPromise(
					adapter.startProcess(forked.providerSandboxId, {
						command: "/bin/bash",
						args: [
							"-c",
							"curl -sf --max-time 10 https://example.com >/dev/null && touch /tmp/zuse-canary-online",
						],
						user: "zuse",
					}),
				);
				await new Promise((resolve) => setTimeout(resolve, 15_000));
				await expect(
					Effect.runPromise(
						adapter.pathExists(
							forked.providerSandboxId,
							"/tmp/zuse-canary-online",
						),
					),
				).resolves.toBe(false);

				// open the fork's network in one call
				await Effect.runPromise(
					adapter.setNetwork(forked.providerSandboxId, { kind: "open" }),
				);
			} catch (cause) {
				failures.push(cause);
			} finally {
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
				throw new AggregateError(failures, "Box live test or cleanup failed");

			// killed boxes must disappear from label recovery
			const gone = await pollUntil(
				() => Effect.runPromise(adapter.recoverByLabel(label)),
				(value) => value === null,
			);
			expect(gone).toBeNull();
		});
	},
);
