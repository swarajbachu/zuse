import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import {
	connectLocalEngine,
	type DesktopEngineEndpoint,
	type EngineChannel,
	readEngineEndpoint,
	requestIdleEngineShutdown,
	writeDesktopEngineConfig,
} from "@zusehq/server/desktop-engine";
import { readEngineBuildId } from "../src/engine-launcher.ts";
import { startEngineAccountOutage } from "./engine-account-fixture.ts";
import {
	ENGINE_TOOL_COMMAND,
	startEngineProviderFixture,
} from "./engine-provider-fixture.ts";

const directory = await mkdtemp(join(tmpdir(), "zuse-engine-recovery-"));
const channels = new Set<EngineChannel>();
const supervisorPath = fileURLToPath(
	new URL("../dist-electron/engine-supervisor.cjs", import.meta.url),
);
let providerFixture:
	| Awaited<ReturnType<typeof startEngineProviderFixture>>
	| undefined;
let supervisor: ChildProcess | undefined;
let accountOutage:
	| Awaited<ReturnType<typeof startEngineAccountOutage>>
	| undefined;
let exited: Promise<void> = Promise.resolve();
const within = async <T>(work: Promise<T>, ms: number): Promise<T> => {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			work,
			new Promise<never>((_, reject) => {
				timer = setTimeout(
					() => reject(new Error("Engine smoke timed out")),
					ms,
				);
			}),
		]);
	} finally {
		clearTimeout(timer);
	}
};
const connect = async (endpoint: DesktopEngineEndpoint) => {
	let next = 0;
	const requests = new Map<
		string,
		{ resolve: (value: unknown) => void; reject: (error: Error) => void }
	>();
	const channel = await connectLocalEngine(endpoint, {
		receive: (frame) => {
			if (frame._tag !== "Rpc") return;
			const response = JSON.parse(frame.payload);
			if (response._tag !== "Exit") return;
			const pending = requests.get(response.requestId);
			requests.delete(response.requestId);
			if (response.exit._tag === "Success")
				pending?.resolve(response.exit.value);
			else
				pending?.reject(
					new Error(`RPC failed: ${JSON.stringify(response.exit)}`),
				);
		},
	});
	channels.add(channel);
	void channel.closed.then(() => {
		channels.delete(channel);
		for (const pending of requests.values())
			pending.reject(new Error("Engine disconnected"));
		requests.clear();
	});
	return {
		channel,
		call: (tag: string, payload: unknown) =>
			within(
				new Promise<unknown>((resolve, reject) => {
					const id = String(next++);
					requests.set(id, { resolve, reject });
					if (
						!channel.send({
							_tag: "Rpc",
							payload: JSON.stringify({
								_tag: "Request",
								id,
								tag,
								payload,
								headers: [],
							}),
						})
					) {
						requests.delete(id);
						reject(new Error("Engine rejected request"));
					}
				}),
				10_000,
			),
	};
};
const waitReady = async (previousPid?: number) =>
	within(
		(async () => {
			while (true) {
				if (supervisor?.exitCode !== null || supervisor?.signalCode !== null)
					throw new Error("Engine supervisor exited before readiness");
				const candidate = await readEngineEndpoint(directory);
				if (candidate !== null && candidate.pid !== previousPid) {
					try {
						const probe = await connectLocalEngine(candidate, {
							receive: () => {},
						});
						probe.close();
						await probe.closed;
						return candidate;
					} catch {}
				}
				await delay(50);
			}
		})(),
		30_000,
	);

try {
	if (process.argv.includes("--account-outage"))
		accountOutage = await startEngineAccountOutage();
	if (
		process.env.ZUSE_ENGINE_CODEX_FIXTURE === "1" ||
		process.argv.includes("--provider-fixture")
	)
		providerFixture = await startEngineProviderFixture(directory);
	const reservation = createServer();
	await new Promise<void>((resolve) =>
		reservation.listen(0, "127.0.0.1", resolve),
	);
	const address = reservation.address();
	assert(address !== null && typeof address !== "string");
	await new Promise<void>((resolve, reject) =>
		reservation.close((error) => (error ? reject(error) : resolve())),
	);
	const buildId = await readEngineBuildId(supervisorPath);
	const launchConfig = {
		userData: directory,
		appVersion: "engine-smoke",
		buildId,
		apiPort: address.port,
		bindHost: "127.0.0.1",
		advertisedHost: null,
		apiUrl: "http://127.0.0.1:9",
	};
	const configPath = await writeDesktopEngineConfig(launchConfig);
	supervisor = spawn(process.execPath, [supervisorPath, configPath], {
		env: {
			...process.env,
			...providerFixture?.environment,
			ELECTRON_RUN_AS_NODE: "1",
			ZUSE_SQLITE_MEMORY: "0",
			MEMOIZE_SQLITE_MEMORY: "0",
		},
		stdio: ["ignore", "ignore", "pipe"],
	});
	supervisor.stderr?.on("data", (data) => process.stderr.write(data));
	exited = new Promise<void>((resolve, reject) => {
		supervisor?.once("exit", () => resolve());
		supervisor?.once("error", reject);
	});
	const initial = await waitReady();
	assert.equal(initial.buildId, buildId);
	const first = await connect(initial);
	const project = join(directory, "project");
	const readToolStarted = () =>
		readFile(join(project, "tool-started.txt"), "utf8").then((text) =>
			text.replaceAll("\r\n", "\n"),
		);
	await mkdir(project);
	const folder = await first.call("workspace.add", { path: project });
	assert(folder !== null && typeof folder === "object");
	const expectedWorkspaces = [{ ...folder, kind: "project" }];
	if (accountOutage !== undefined) {
		const descriptor = await first.call("connect.describe", null);
		assert(
			descriptor !== null &&
				typeof descriptor === "object" &&
				"environmentId" in descriptor,
		);
		await first.call("connect.apiConfig", {
			apiUrl: accountOutage.url,
			apiIssuer: "engine-outage-fixture",
			environmentId: descriptor.environmentId,
			environmentCredential: "fixture-only-credential",
		});
	}
	first.channel.close();
	await first.channel.closed;
	const second = await connect(initial);
	assert.deepEqual(await second.call("workspace.list", {}), expectedWorkspaces);
	assert.equal((await readEngineEndpoint(directory))?.pid, initial.pid);
	console.log(
		"PASS: renderer detach and reattach preserve the engine and its data",
	);
	process.kill(initial.pid, "SIGKILL");
	await within(second.channel.closed, 5_000);
	let recovered = await waitReady(initial.pid);
	assert.equal(recovered.buildId, buildId);
	assert.notEqual(recovered.token, initial.token);
	await assert.rejects(
		connectLocalEngine(
			{ ...recovered, token: initial.token },
			{ receive: () => {} },
		),
	);
	let third = await connect(recovered);
	assert.deepEqual(await third.call("workspace.list", {}), expectedWorkspaces);
	console.log(
		"PASS: worker crash restarts the engine with durable data and a fresh capability",
	);
	if (
		process.env.ZUSE_LIVE_ENGINE_CODEX === "1" ||
		providerFixture !== undefined
	) {
		const model =
			providerFixture === undefined
				? process.env.ZUSE_LIVE_CODEX_MODEL?.trim()
				: "gpt-5.5";
		assert(
			model,
			"Set ZUSE_LIVE_CODEX_MODEL to an available model for live engine tests",
		);
		assert(folder !== null && typeof folder === "object" && "id" in folder);
		const created = await third.call("chat.create", {
			projectId: folder.id,
			providerId: "codex",
			title: "Engine crash fixture",
			model,
			runtimeMode: "full-access",
			background: true,
			initialPrompt: [
				"Run exactly this shell command once in this temporary fixture:",
				ENGINE_TOOL_COMMAND,
				"Then reply done. Do not repeat the command.",
			].join("\n"),
		});
		assert(
			created !== null &&
				typeof created === "object" &&
				"initialSession" in created,
		);
		const session = created.initialSession;
		assert(session !== null && typeof session === "object" && "id" in session);
		await within(
			(async () => {
				while (true) {
					if ((await readToolStarted().catch(() => "")) === "started\n") return;
					await delay(100);
				}
			})(),
			90_000,
		);
		if (providerFixture !== undefined)
			assert(providerFixture.requestCount() > 0);
		if (accountOutage !== undefined) {
			await within(
				(async () => {
					while (true) {
						const database = new DatabaseSync(join(directory, "zuse.sqlite"), {
							readOnly: true,
						});
						try {
							const lease = database
								.prepare(
									"SELECT provider_activity_at FROM session_ingestion_leases WHERE session_id=?",
								)
								.get(String(session.id));
							if (typeof lease?.provider_activity_at === "number") break;
						} finally {
							database.close();
						}
						await delay(100);
					}
				})(),
				10_000,
			);
			assert(accountOutage.requests.some((path) => path.includes("activity")));
			console.log(
				"PASS: linked-account HTTP outage does not block provider ingestion or lease renewal",
			);
		}
		const toolPid = Number(
			await readFile(join(project, "tool-pid.txt"), "utf8"),
		);
		assert(Number.isSafeInteger(toolPid) && toolPid > 1);
		assert.equal(
			await requestIdleEngineShutdown(recovered, { userData: directory }),
			"busy",
		);
		third.channel.close();
		await third.channel.closed;
		await delay(1_000);
		process.kill(toolPid, 0);
		assert.equal((await readEngineEndpoint(directory))?.pid, recovered.pid);
		console.log(
			"PASS: a real provider tool remains active with every desktop client detached; update refuses it",
		);
		process.kill(recovered.pid, "SIGKILL");
		recovered = await waitReady(recovered.pid);
		third = await connect(recovered);
		await within(
			(async () => {
				while (true) {
					const state = await third.call("session.get", {
						sessionId: session.id,
					});
					assert(
						state !== null && typeof state === "object" && "status" in state,
					);
					const database = new DatabaseSync(join(directory, "zuse.sqlite"), {
						readOnly: true,
					});
					let activeCount: number | bigint | null = null;
					try {
						const active = database
							.prepare(
								"SELECT COUNT(*) AS count FROM session_turns WHERE session_id=? AND status IN ('starting','running','finalizing')",
							)
							.get(String(session.id));
						if (
							typeof active?.count === "number" ||
							typeof active?.count === "bigint"
						)
							activeCount = active.count;
					} finally {
						database.close();
					}
					if (
						activeCount === 0 &&
						state.status !== "booting" &&
						state.status !== "running"
					)
						return;
					await delay(100);
				}
			})(),
			45_000,
		);
		await within(
			(async () => {
				while (true) {
					try {
						process.kill(toolPid, 0);
					} catch (error) {
						if (
							error !== null &&
							typeof error === "object" &&
							"code" in error &&
							error.code === "ESRCH"
						)
							return;
						throw error;
					}
					await delay(100);
				}
			})(),
			10_000,
		);
		assert.equal(await readToolStarted(), "started\n");
		const history = await third.call("messages.list", {
			sessionId: session.id,
		});
		assert(Array.isArray(history) && history.length > 0);
		console.log(
			"PASS: real provider worker loss cleans the tool process, preserves history, and reaches a terminal turn without replaying the command",
		);
	}
	// Windows implements child.kill(SIGTERM) as forced termination, with no
	// signal handler. Use the engine's authenticated cooperative shutdown there.
	if (process.platform === "win32") {
		assert.equal(
			await requestIdleEngineShutdown(recovered, { userData: directory }),
			"stopped",
		);
	} else supervisor.kill("SIGTERM");
	await within(exited, 10_000);
	await within(third.channel.closed, 5_000);
	assert.equal(await readEngineEndpoint(directory), null);
	assert.throws(() => process.kill(recovered.pid, 0), { code: "ESRCH" });
	console.log(
		"PASS: supervisor shutdown awaits the worker and removes the endpoint",
	);
	supervisor = spawn(process.execPath, [supervisorPath, configPath], {
		env: {
			...process.env,
			...providerFixture?.environment,
			ELECTRON_RUN_AS_NODE: "1",
			ZUSE_SQLITE_MEMORY: "0",
			MEMOIZE_SQLITE_MEMORY: "0",
		},
		stdio: ["ignore", "ignore", "pipe"],
	});
	supervisor.stderr?.on("data", (chunk) => process.stderr.write(chunk));
	exited = new Promise<void>((resolve, reject) => {
		supervisor?.once("exit", () => resolve());
		supervisor?.once("error", reject);
	});
	const idle = await waitReady();
	const fourth = await connect(idle);
	assert.deepEqual(await fourth.call("workspace.list", {}), expectedWorkspaces);
	assert.equal(
		await requestIdleEngineShutdown(idle, { userData: directory }),
		"stopped",
	);
	await within(exited, 5_000);
	await within(fourth.channel.closed, 5_000);
	assert.equal(await readEngineEndpoint(directory), null);
	console.log(
		"PASS: authenticated idle shutdown waits for engine and supervisor exit",
	);
	const database = await readFile(join(directory, "zuse.sqlite"));
	await writeDesktopEngineConfig({ ...launchConfig, buildId: "stale-build" });
	for (const entry of [
		supervisorPath,
		fileURLToPath(new URL("../dist-electron/engine-main.cjs", import.meta.url)),
	]) {
		let failure = "";
		supervisor = spawn(process.execPath, [entry, configPath], {
			env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
			stdio: ["ignore", "pipe", "pipe"],
		});
		supervisor.stdout?.on("data", (chunk) => {
			failure += String(chunk);
		});
		supervisor.stderr?.on("data", (chunk) => {
			failure += String(chunk);
		});
		exited = new Promise<void>((resolve, reject) => {
			supervisor?.once("exit", () => resolve());
			supervisor?.once("error", reject);
		});
		await within(exited, 10_000);
		assert.notEqual(supervisor.exitCode, 0);
		assert.match(failure, /engine files changed/);
		assert.equal(await readEngineEndpoint(directory), null);
		assert.deepEqual(await readFile(join(directory, "zuse.sqlite")), database);
	}
	console.log(
		"PASS: changed engine builds are rejected before modifying durable data",
	);
} catch (error) {
	process.stderr.write(
		await readFile(join(directory, "engine", "runtime.log"), "utf8").catch(
			() => "",
		),
	);
	throw error;
} finally {
	for (const channel of channels) channel.close();
	if (
		supervisor !== undefined &&
		supervisor.exitCode === null &&
		supervisor.signalCode === null
	) {
		supervisor.kill("SIGTERM");
		await within(exited, 10_000).catch(async () => {
			supervisor?.kill("SIGKILL");
			await exited;
		});
	}
	await providerFixture?.close();
	await accountOutage?.close();
	await rm(directory, { recursive: true, force: true });
}
