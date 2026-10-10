import { Boxd } from "@boxd-sh/sdk";
import { Effect, Redacted } from "effect";
import { describe, expect, test } from "vitest";
import { makeBoxSandboxProvider } from "../../src/box.ts";
import { makeBoxdSandboxProvider } from "../../src/boxd.ts";
import { makeE2bSandboxProvider } from "../../src/e2b.ts";
import type {
	SandboxProcessInput,
	SandboxProviderAdapter,
} from "../../src/index.ts";

// Opt-in live contract: disposable provider compute only, no account/runtime
// enrollment or customer data. Boxd uses a stock image when the configured
// Zuse template is unavailable; this does not certify product startup latency.
const enabled = process.env.ZUSE_LIVE_PROCESS_OWNERSHIP === "1";
const run = <A>(effect: Effect.Effect<A, unknown>) => Effect.runPromise(effect);

const fileEventually = async (
	adapter: SandboxProviderAdapter,
	id: string,
	path: string,
	user: string,
): Promise<string> => {
	for (let attempt = 0; attempt < 20; attempt++) {
		const result = await Effect.runPromiseExit(
			adapter.readTextFile(id, path, user),
		);
		if (result._tag === "Success") return result.value.trim();
		await new Promise((resolve) => setTimeout(resolve, 200));
	}
	throw new Error("Ownership fixture file did not become readable");
};

const ownershipContract = async (
	adapter: SandboxProviderAdapter,
	id: string,
	user: string,
	warm: boolean,
): Promise<void> => {
	const selector = { tag: "zuse-live-ownership" };
	const prefix = `/home/${user}/zuse-live-ownership`;
	const input = (generation: number): SandboxProcessInput => ({
		command: "/bin/bash",
		args: [
			"-c",
			`echo $$ > ${prefix}.pid; echo started >> ${prefix}.starts; exec sleep 600`,
		],
		user,
		tag: selector.tag,
		activation: { generation, operationId: `live-ownership-${generation}` },
	});
	const observe = () => {
		if (adapter.inspectProcess === undefined)
			throw new Error("Missing ownership observation");
		return run(adapter.inspectProcess(id, selector, user));
	};
	const read = (suffix: string) =>
		fileEventually(adapter, id, `${prefix}.${suffix}`, user);

	await run(adapter.replaceProcess(id, selector, input(1)));
	const originalPid = await read("pid");
	expect(Number(originalPid)).toBeGreaterThan(0);
	await run(adapter.replaceProcess(id, selector, input(1)));
	expect(await read("starts")).toBe("started");
	expect(await observe()).toBe("active");

	// Repeated wake checks on memory-preserving providers; Boat must preserve
	// files and admit an authorized cold replacement instead of inventing a PID.
	for (let attempt = 0; attempt < (warm ? 3 : 1); attempt++) {
		await run(adapter.pause(id));
		const start = performance.now();
		const resumed = await run(adapter.resume(id, 600, "pause"));
		console.info("live ownership wake", {
			provider: adapter.providerId,
			durationMs: Math.round(performance.now() - start),
		});
		expect(resumed.state).toBe("running");
		expect(await read("starts")).toBe("started");
		if (warm) {
			expect(await observe()).toBe("active");
			expect(await read("pid")).toBe(originalPid);
		}
	}

	await run(adapter.replaceProcess(id, selector, input(2)));
	expect(await observe()).toBe("active");
	const currentPid = await read("pid");
	const stale = await Effect.runPromiseExit(
		adapter.replaceProcess(id, selector, input(1)),
	);
	expect(stale._tag).toBe("Failure");
	expect(await read("pid")).toBe(currentPid);
	expect(await observe()).toBe("active");
};

const e2bKey = process.env.E2B_API_KEY;
const boatKey = process.env.BOX_API_KEY;
const boatTemplate = process.env.BOX_TEMPLATE_SNAPSHOT;
const boxdKey = process.env.BOXD_API_KEY;

describe("Live process ownership contract", () => {
	test.skipIf(!enabled || e2bKey === undefined)(
		"E2B retains and fences its owned process",
		{ timeout: 240_000 },
		async () => {
			if (e2bKey === undefined) throw new Error("Missing E2B key");
			const adapter = makeE2bSandboxProvider({
				apiKey: Redacted.make(e2bKey),
				templateId: "base",
			});
			const created = await run(
				adapter.create({
					sandboxId: "live-ownership",
					providerLabel: `zuse-ownership-${Date.now().toString(36)}`,
					timeoutSeconds: 600,
					env: {},
					network: { kind: "open" },
					onTimeout: "pause",
				}),
			);
			try {
				await ownershipContract(
					adapter,
					created.providerSandboxId,
					"user",
					true,
				);
			} finally {
				await run(adapter.kill(created.providerSandboxId));
			}
		},
	);

	test.skipIf(!enabled || boatKey === undefined || boatTemplate === undefined)(
		"Boat preserves files and fences cold ownership",
		{ timeout: 300_000 },
		async () => {
			if (boatKey === undefined || boatTemplate === undefined)
				throw new Error("Missing Boat key/template");
			const adapter = makeBoxSandboxProvider({
				apiKey: Redacted.make(boatKey),
				templateSnapshot: boatTemplate,
				templateVersion: "live-ownership",
			});
			const created = await run(
				adapter.create({
					sandboxId: "live-ownership",
					providerLabel: `zuse-ownership-${Date.now().toString(36)}`,
					timeoutSeconds: 600,
					env: {},
					network: { kind: "open" },
					onTimeout: "pause",
				}),
			);
			try {
				await ownershipContract(
					adapter,
					created.providerSandboxId,
					"zuse",
					false,
				);
			} finally {
				await run(adapter.kill(created.providerSandboxId));
			}
		},
	);

	test.skipIf(!enabled || boxdKey === undefined)(
		"Boxd stock fixture retains and fences its owned process",
		{ timeout: 300_000 },
		async () => {
			if (boxdKey === undefined) throw new Error("Missing Boxd key");
			const org = process.env.BOXD_ORG;
			const client = new Boxd({ apiKey: boxdKey, timeout: 30_000 });
			const adapter = makeBoxdSandboxProvider({
				apiKey: Redacted.make(boxdKey),
				templateSnapshot: "unused-stock-fixture",
				templateVersion: "live-ownership",
				org,
			});
			const created = await client.machines.create({
				name: `zuse-ownership-${Date.now().toString(36)}`,
				org,
				isolated: true,
				config: {
					vcpu: 1,
					memory: "4G",
					autoSuspendTimeout: 0,
					autoDestroyTimeout: 600,
				},
			});
			try {
				await client.machines.waitUntilReady(created.id, { timeout: 120_000 });
				const setup = await client.machines.exec(created.id, {
					command:
						"sudo -n bash -c 'id zuse >/dev/null 2>&1 || useradd -m -s /bin/bash zuse; install -d -m 0700 -o zuse -g zuse /run/zuse-secrets; command -v flock >/dev/null'",
					timeout: 30_000,
				});
				expect(setup.exitCode).toBe(0);
				await ownershipContract(adapter, created.id, "zuse", true);
			} finally {
				await client.machines.delete(created.id);
			}
		},
	);
});
