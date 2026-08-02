import { spawn } from "node:child_process";
import { mkdir, rm } from "node:fs/promises";
import { homedir, hostname } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { HOSTED_APP_URL, WORKOS_PUBLIC_CLIENT_ID } from "@zuse/contracts";
import { Effect } from "effect";

import { SessionStoreLive } from "../auth/layers/session-store.ts";
import { refreshSession, type SessionBundle } from "../auth/layers/workos.ts";
import { SessionStore } from "../auth/services/session-store.ts";
import { runHeadlessServer } from "../bin.ts";
import { parseServeCommand } from "./command.ts";
import { ensureServeSession } from "./device-login.ts";
import {
	installDurableServeRuntime,
	latestServeRuntimeVersion,
	readActiveServeRuntime,
	writeActiveServeRuntime,
} from "./runtime-installer.ts";
import {
	getServeServiceStatus,
	installServeService,
	resolveServeServicePaths,
	stopServeService,
	UnsupportedServiceManagerError,
	uninstallServeService,
} from "./service-manager.ts";

const DEFAULT_RELAY_URL = "https://relay.stuff.md";
const workosClientId = (env: NodeJS.ProcessEnv): string =>
	(env.WORKOS_CLIENT_ID ?? "").trim() || WORKOS_PUBLIC_CLIENT_ID;

export const resolveServeDataDir = (
	env: NodeJS.ProcessEnv,
	override?: string,
	runtime: {
		readonly platform?: NodeJS.Platform;
		readonly homeDir?: string;
	} = {},
): string => {
	if (override !== undefined) return override;
	if (env.ZUSE_USER_DATA) return env.ZUSE_USER_DATA;
	if (env.ZUSE_USER_DATA_DIR) return env.ZUSE_USER_DATA_DIR;
	if (env.MEMOIZE_USER_DATA_DIR) return env.MEMOIZE_USER_DATA_DIR;
	const platform = runtime.platform ?? process.platform;
	const homeDir = runtime.homeDir ?? homedir();
	if (platform === "darwin") {
		return join(homeDir, "Library", "Application Support", "Zuse Alpha");
	}
	const xdg = env.XDG_DATA_HOME ?? join(homeDir, ".local", "share");
	return join(xdg, "zuse");
};

const openBrowser = (url: string): void => {
	const [command, args] =
		process.platform === "darwin"
			? (["open", [url]] as const)
			: (["xdg-open", [url]] as const);
	const child = spawn(command, args, { detached: true, stdio: "ignore" });
	child.on("error", () => undefined);
	child.unref();
};

const foregroundArgs = (dataDir: string): ReadonlyArray<string> => [
	"serve",
	"--data-dir",
	dataDir,
	"--auth",
	"protected",
];

type LocalRelayConfig = {
	readonly environmentId: string;
	readonly relayUrl: string;
	readonly tunnelHostname?: string;
};

const readLocalRelayConfig = (dataDir: string): LocalRelayConfig | null => {
	try {
		const database = new DatabaseSync(join(dataDir, "zuse.sqlite"), {
			readOnly: true,
		});
		try {
			const row = database
				.prepare(
					"SELECT environment_id, relay_url, tunnel_hostname FROM relay_config LIMIT 1",
				)
				.get() as
				| {
						readonly environment_id?: unknown;
						readonly relay_url?: unknown;
						readonly tunnel_hostname?: unknown;
				  }
				| undefined;
			if (
				typeof row?.environment_id !== "string" ||
				typeof row.relay_url !== "string"
			) {
				return null;
			}
			return {
				environmentId: row.environment_id,
				relayUrl: row.relay_url,
				tunnelHostname:
					typeof row.tunnel_hostname === "string"
						? row.tunnel_hostname
						: undefined,
			};
		} finally {
			database.close();
		}
	} catch {
		return null;
	}
};

const installedAgents = async (): Promise<ReadonlyArray<string>> => {
	const candidates = [
		["Codex", "codex"],
		["Claude", "claude"],
		["OpenCode", "opencode"],
		["Grok", "grok"],
	] as const;
	const results = await Promise.all(
		candidates.map(async ([label, executable]) => {
			try {
				const child = spawn(executable, ["--version"], {
					stdio: "ignore",
				});
				const code = await new Promise<number | null>((resolve) => {
					let settled = false;
					const finish = (value: number | null) => {
						if (settled) return;
						settled = true;
						clearTimeout(timer);
						resolve(value);
					};
					const timer = setTimeout(() => {
						child.kill("SIGTERM");
						finish(null);
					}, 2_000);
					child.once("error", () => finish(null));
					child.once("exit", finish);
				});
				return code === 0 ? label : null;
			} catch {
				return null;
			}
		}),
	);
	return results.filter((value) => value !== null);
};

const serverReachable = async (env: NodeJS.ProcessEnv): Promise<boolean> => {
	try {
		const port = Number(env.ZUSE_PORT ?? 4859);
		const response = await fetch(`http://127.0.0.1:${port}/auth/session`, {
			signal: AbortSignal.timeout(2_000),
		});
		return response.status < 500;
	} catch {
		return false;
	}
};

const printStatus = async (
	status: Awaited<ReturnType<typeof getServeServiceStatus>>,
	options: {
		readonly json: boolean;
		readonly dataDir: string;
		readonly env: NodeJS.ProcessEnv;
	},
): Promise<void> => {
	const relay = readLocalRelayConfig(options.dataDir);
	const [agents, reachable] = await Promise.all([
		installedAgents(),
		serverReachable(options.env),
	]);
	const value = {
		schemaVersion: 1,
		computer: hostname(),
		service: status.running
			? "running"
			: status.installed
				? "stopped"
				: "missing",
		tunnel: relay?.tunnelHostname === undefined ? "unavailable" : "configured",
		runtimeVersion: options.env.ZUSE_RUNTIME_VERSION ?? "0.0.0",
		agents,
		reachable,
		environmentId: relay?.environmentId ?? null,
		durable: status.durable,
		dataDir: options.dataDir,
		appUrl: HOSTED_APP_URL,
	};
	if (options.json) {
		console.log(JSON.stringify(value));
		return;
	}
	console.log(`Computer   ${value.computer}`);
	console.log(`Service    ${value.service}`);
	console.log(`Tunnel     ${value.tunnel}`);
	console.log(`Agents     ${value.agents.join(", ") || "None detected"}`);
	console.log(`Status     ${value.reachable ? "Online" : "Unavailable"}`);
	console.log(`Open       ${value.appUrl}`);
};

const waitForReachability = async (
	env: NodeJS.ProcessEnv,
	timeoutMs = 45_000,
): Promise<boolean> => {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (await serverReachable(env)) return true;
		await new Promise((resolve) => setTimeout(resolve, 1_000));
	}
	return false;
};

const clearServeSession = (): Promise<void> =>
	Effect.runPromise(
		Effect.gen(function* () {
			const store = yield* SessionStore;
			yield* store.clear();
		}).pipe(Effect.provide(SessionStoreLive)),
	);

const currentServeSession = (): Promise<SessionBundle | null> =>
	Effect.runPromise(
		Effect.gen(function* () {
			const store = yield* SessionStore;
			return yield* store.read();
		}).pipe(Effect.provide(SessionStoreLive)),
	);

const unlinkServeRegistration = async (
	dataDir: string,
	env: NodeJS.ProcessEnv,
): Promise<void> => {
	const relay = readLocalRelayConfig(dataDir);
	if (relay === null) return;
	let session = await currentServeSession();
	if (session === null) {
		throw new Error(
			"Cannot revoke this computer because its account authorization is missing.",
		);
	}
	if (session.expiresAt - Date.now() <= 60_000) {
		const refreshed = await Effect.runPromise(
			refreshSession(workosClientId(env), session.refreshToken),
		);
		session = refreshed;
		await Effect.runPromise(
			Effect.gen(function* () {
				const store = yield* SessionStore;
				yield* store.write(refreshed);
			}).pipe(Effect.provide(SessionStoreLive)),
		);
	}
	const response = await fetch(
		`${relay.relayUrl}/v1/client/environment-unlink`,
		{
			method: "POST",
			headers: {
				authorization: `Bearer ${session.accessToken}`,
				"content-type": "application/json",
			},
			body: JSON.stringify({ environmentId: relay.environmentId }),
			signal: AbortSignal.timeout(15_000),
		},
	);
	if (!response.ok && response.status !== 404) {
		throw new Error(`Computer revocation failed (${response.status}).`);
	}
};

export const runServePackageCli = async (
	argv: ReadonlyArray<string>,
	env: NodeJS.ProcessEnv = process.env,
	options: { readonly packageVersion?: string } = {},
): Promise<void> => {
	const normalized = argv[0] === "serve" ? argv : ["serve", ...argv];
	const command = parseServeCommand(normalized);
	env.ZUSE_RUNTIME_VERSION = options.packageVersion ?? "0.0.0";
	env.ZUSE_RELAY_URL = env.ZUSE_RELAY_URL ?? DEFAULT_RELAY_URL;
	const dataDir = resolveServeDataDir(env, command.dataDir);
	env.ZUSE_USER_DATA = dataDir;
	const servicePaths = resolveServeServicePaths({ dataDir });
	const installService = (executable: string) =>
		installServeService({
			executable,
			paths: servicePaths,
			relayUrl: env.ZUSE_RELAY_URL,
		});

	if (command.action === "start" && command.foreground) {
		env.ZUSE_SERVE_AUTO_LINK = "1";
		runHeadlessServer({
			host: "127.0.0.1",
			port: Number(env.ZUSE_PORT ?? 4859),
			dataDir,
			staticDir: undefined,
			open: false,
			policy: "protected",
			pairing: true,
		});
		return;
	}

	if (command.action === "status") {
		await printStatus(await getServeServiceStatus(servicePaths), {
			json: command.json,
			dataDir,
			env,
		});
		return;
	}

	if (command.action === "stop") {
		await stopServeService(servicePaths);
		console.log("Zuse Serve is stopped.");
		return;
	}

	if (command.action === "logout") {
		await unlinkServeRegistration(dataDir, env);
		await stopServeService(servicePaths).catch(() => undefined);
		await clearServeSession();
		console.log("Zuse Serve is signed out and stopped.");
		return;
	}

	if (command.action === "uninstall") {
		await uninstallServeService(servicePaths);
		await rm(join(dataDir, "runtime"), { recursive: true, force: true });
		console.log(
			"Zuse Serve was uninstalled. Your workspaces were not deleted.",
		);
		return;
	}

	if (command.action === "update") {
		if (!command.force) {
			throw new Error(
				"Automatic runtime updates require active-work readiness checks. Run with --force only when no agent or terminal work is active.",
			);
		}
		const version = await latestServeRuntimeVersion();
		const executable = await installDurableServeRuntime({ dataDir, version });
		const previous = await readActiveServeRuntime(dataDir);
		try {
			await installService(executable);
		} catch (cause) {
			if (previous !== null) {
				await installService(previous.executable).catch(() => undefined);
			}
			throw cause;
		}
		if (!(await waitForReachability(env))) {
			if (previous !== null) {
				await installService(previous.executable);
				await waitForReachability(env, 20_000);
				throw new Error(
					"The updated runtime failed its readiness check and Zuse restored the previous runtime.",
				);
			}
			throw new Error(
				"The updated runtime failed its readiness check. No previous runtime was available to restore.",
			);
		}
		await writeActiveServeRuntime(dataDir, { version, executable });
		console.log(`Zuse Serve was updated to ${version}.`);
		return;
	}

	await mkdir(dataDir, { recursive: true, mode: 0o700 });
	const session = await Effect.runPromise(
		ensureServeSession({
			clientId: workosClientId(env),
			onPrompt: async (grant) => {
				console.log("Authorize this computer");
				console.log(`Code       ${grant.userCode}`);
				console.log(`Open       ${grant.verificationUriComplete}`);
				if (env.ZUSE_NO_OPEN !== "1")
					openBrowser(grant.verificationUriComplete);
			},
		}),
	);
	let installedExecutable: string;
	try {
		const packageVersion = options.packageVersion ?? "0.0.0";
		installedExecutable =
			packageVersion === "0.0.0"
				? (process.argv[1] ?? process.execPath)
				: await installDurableServeRuntime({
						dataDir,
						version: packageVersion,
					});
		await installService(installedExecutable);
	} catch (cause) {
		if (cause instanceof UnsupportedServiceManagerError) {
			console.warn(`${cause.message} Starting in the foreground instead.`);
			env.ZUSE_SERVE_AUTO_LINK = "1";
			runHeadlessServer({
				host: "127.0.0.1",
				port: Number(env.ZUSE_PORT ?? 4859),
				dataDir,
				staticDir: undefined,
				open: false,
				policy: "protected",
				pairing: true,
			});
			return;
		}
		throw cause;
	}
	const reachable = await waitForReachability(env);
	if (!reachable) {
		throw new Error(
			"Zuse Serve was installed, but the background host did not become reachable. Run `zuse serve status --json` for diagnostics.",
		);
	}
	await writeActiveServeRuntime(dataDir, {
		version: options.packageVersion ?? "0.0.0",
		executable: installedExecutable,
	});

	console.log("");
	console.log("Zuse Serve is ready");
	console.log("");
	console.log(`Computer   ${hostname()}`);
	console.log("Status     Online");
	console.log(`Account    ${session.email}`);
	const agents = await installedAgents();
	console.log(`Agents     ${agents.join(", ") || "None detected"}`);
	console.log(`Open       ${HOSTED_APP_URL}`);
};

export { foregroundArgs };
