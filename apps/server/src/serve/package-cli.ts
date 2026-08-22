import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { homedir, hostname } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

import { environmentRoute } from "@zuse/client-runtime/environment-scope";
import {
	buildConnectDeepLink,
	DEFAULT_SERVE_PORT,
	formatPairingCodeForDisplay,
	HOSTED_APP_URL,
	type ServeStatusV1,
	WORKOS_PUBLIC_CLIENT_ID,
	wsBaseUrlForHttpBase,
} from "@zuse/contracts";
import { probeZuseLoopback, setTailnetShareEnabled } from "@zuse/tailnet";
import { Effect } from "effect";

import { SessionStoreLive } from "../auth/layers/session-store.ts";
import { refreshStoredSession } from "../auth/layers/stored-session-refresh.ts";
import type { SessionBundle } from "../auth/layers/workos.ts";
import { SessionStore } from "../auth/services/session-store.ts";
import { runHeadlessServer, type ServeOptions } from "../bin.ts";
import { SUPPORTED_PROVIDER_CLIS } from "../provider/provider-cli-registry.ts";
import { parseServeCommand } from "./command.ts";
import { ensureServeSession } from "./device-login.ts";
import {
	type ActiveServeRuntime,
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
import {
	readServeSettings,
	type ServeSettings,
	writeServeSettings,
} from "./settings.ts";

export {
	ServeServiceState,
	ServeStatusV1,
	ServeTunnelState,
} from "@zuse/contracts";

const DEFAULT_RELAY_URL = "https://relay.stuff.md";
export const SERVE_HELP = `Zuse Serve

Run and manage Zuse on this computer.

Usage:
  zuse serve [start] [--foreground] [--ssh-managed] [--tailscale] [--no-account]
             [--lan | --host <addr>] [--port <n>] [--data-dir <path>]
  zuse serve status [--json] [--data-dir <path>]
  zuse serve stop [--data-dir <path>]
  zuse serve update --force [--data-dir <path>]
  zuse serve logout [--data-dir <path>]
  zuse serve uninstall [--data-dir <path>]

Commands:
  start       Start Zuse Serve (default)
  status      Show service, tunnel, agent, and reachability status
  stop        Stop the background service
  update      Install the latest runtime after an explicit readiness override
  logout      Revoke this computer and stop the service
  uninstall   Remove the service and runtime, preserving workspaces

Options:
  --foreground       Run in the current terminal
  --ssh-managed      Run loopback-only without account linking for SSH tunnels
  --tailscale        Also share privately over Tailscale Serve HTTPS
  --no-account       Skip account sign-in and the managed tunnel
  --lan              Listen on the local network (same as --host 0.0.0.0)
  --host <addr>      Listen on a specific address (default 127.0.0.1)
  --port <n>         Listen on a specific port (default ${DEFAULT_SERVE_PORT})
  --json             Emit versioned JSON from status
  --force            Confirm a safe update window
  --data-dir <path>  Override the Zuse data directory
  -h, --help         Show this help
  -V, --version      Show the package version`;
const workosClientId = (env: NodeJS.ProcessEnv): string =>
	(env.WORKOS_CLIENT_ID ?? "").trim() || WORKOS_PUBLIC_CLIENT_ID;

/**
 * Account sign-in (and the managed tunnel it unlocks) is the default access
 * path. `--tailscale` is an *additional* access method, not a replacement —
 * only `--ssh-managed` (tunnel owns transport) and an explicit `--no-account`
 * skip it, so a served machine never silently disappears from the account.
 */
export const requiresServeAccountAuthorization = (input: {
	readonly sshManaged: boolean;
	readonly noAccount: boolean;
	readonly cloudWorkspaceId?: string;
}): boolean =>
	!input.sshManaged && !input.noAccount && input.cloudWorkspaceId === undefined;

export const shouldAutoLinkForeground = (input: {
	readonly sshManaged: boolean;
	readonly noAccount: boolean;
	readonly cloudWorkspaceId?: string;
}): boolean =>
	!input.sshManaged && !input.noAccount && input.cloudWorkspaceId === undefined;

/**
 * The browser client that ships inside `@zusehq/server`'s published `dist`.
 * Resolution order: explicit env override, `dist/client` next to the bundled
 * CLI, `dist/client` relative to this source file (dev/tsx), then the
 * installed `@zusehq/server` package. Missing client → undefined (API-only).
 */
export const resolveServeStaticDir = (
	env: NodeJS.ProcessEnv,
	moduleUrl: string = import.meta.url,
): string | undefined => {
	if (env.ZUSE_STATIC_DIR !== undefined && env.ZUSE_STATIC_DIR !== "") {
		return env.ZUSE_STATIC_DIR;
	}
	const moduleDir = dirname(fileURLToPath(moduleUrl));
	const candidates = [
		join(moduleDir, "client"),
		join(moduleDir, "..", "..", "dist", "client"),
	];
	try {
		const packageJson = createRequire(moduleUrl).resolve(
			"@zusehq/server/package.json",
		);
		candidates.push(join(dirname(packageJson), "dist", "client"));
	} catch {
		// Not installed as a package (monorepo dev) — file candidates cover it.
	}
	return candidates.find((candidate) =>
		existsSync(join(candidate, "index.html")),
	);
};

export const foregroundServeOptions = (
	env: NodeJS.ProcessEnv,
	command: {
		readonly sshManaged: boolean;
		readonly dataDir?: string;
		readonly host?: string;
		readonly port?: number;
	},
	tailnetOrigin?: string,
): ServeOptions => ({
	host: command.host ?? env.ZUSE_HOST ?? "127.0.0.1",
	port: command.port ?? Number(env.ZUSE_PORT ?? DEFAULT_SERVE_PORT),
	dataDir: resolveServeDataDir(env, command.dataDir),
	staticDir: resolveServeStaticDir(env),
	open: false,
	policy: command.sshManaged ? "local" : "protected",
	pairing: !command.sshManaged && env.ZUSE_ENABLE_PAIRING !== "0",
	pairingPublicBaseUrl: tailnetOrigin,
});

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

export type ServePairingBootstrap = {
	readonly browserUrl: string;
	readonly qrText: string;
	readonly code?: string;
	readonly expiresAt: string;
};

/**
 * The daemon writes its boot pairing details to `<dataDir>/pairing.json`
 * (see `runHeadlessServer`); the CLI reads that file instead of scraping
 * service logs. Expired bootstraps are treated as absent.
 */
export const readServePairingBootstrap = async (
	dataDir: string,
): Promise<ServePairingBootstrap | null> => {
	try {
		const raw = JSON.parse(
			await readFile(join(dataDir, "pairing.json"), "utf8"),
		) as {
			readonly browserUrl?: unknown;
			readonly qrText?: unknown;
			readonly code?: unknown;
			readonly expiresAt?: unknown;
		};
		if (
			typeof raw.browserUrl !== "string" ||
			typeof raw.qrText !== "string" ||
			typeof raw.expiresAt !== "string" ||
			Date.parse(raw.expiresAt) <= Date.now()
		) {
			return null;
		}
		return {
			browserUrl: raw.browserUrl,
			qrText: raw.qrText,
			code: typeof raw.code === "string" ? raw.code : undefined,
			expiresAt: raw.expiresAt,
		};
	} catch {
		return null;
	}
};

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
	const results = await Promise.all(
		SUPPORTED_PROVIDER_CLIS.map(async ({ displayName, cliBinary }) => {
			try {
				const child = spawn(cliBinary, ["--version"], {
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
				return code === 0 ? displayName : null;
			} catch {
				return null;
			}
		}),
	);
	return results.filter((value) => value !== null);
};

const serverReachable = async (
	env: NodeJS.ProcessEnv,
	portOverride?: number,
): Promise<boolean> => {
	try {
		const port = portOverride ?? Number(env.ZUSE_PORT ?? DEFAULT_SERVE_PORT);
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
		readonly port?: number;
	},
): Promise<void> => {
	const relay = readLocalRelayConfig(options.dataDir);
	const [agents, reachable] = await Promise.all([
		installedAgents(),
		serverReachable(options.env, options.port),
	]);
	const value: ServeStatusV1 = {
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
	if (relay?.tunnelHostname !== undefined) {
		console.log(`Tunnel     https://${relay.tunnelHostname}`);
	} else {
		console.log(`Tunnel     ${value.tunnel}`);
	}
	console.log(`Agents     ${value.agents.join(", ") || "None detected"}`);
	console.log(`Status     ${value.reachable ? "Online" : "Unavailable"}`);
	console.log(`Open       ${serveAppUrl(relay)}`);
};

/** Stable per-computer hosted URL once linked; the hosted root otherwise. */
const serveAppUrl = (relay: LocalRelayConfig | null): string =>
	relay === null
		? HOSTED_APP_URL
		: `${HOSTED_APP_URL}${environmentRoute(relay.environmentId)}`;

const waitForReachability = async (
	env: NodeJS.ProcessEnv,
	timeoutMs = 45_000,
	portOverride?: number,
): Promise<boolean> => {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (await serverReachable(env, portOverride)) return true;
		await new Promise((resolve) => setTimeout(resolve, 1_000));
	}
	return false;
};

/**
 * The daemon links to the relay shortly after boot; wait briefly for the
 * persisted relay config so the start summary can print real URLs. Returns
 * whatever is on disk when the wait expires.
 */
const waitForRelayConfig = async (
	dataDir: string,
	timeoutMs: number,
): Promise<LocalRelayConfig | null> => {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const relay = readLocalRelayConfig(dataDir);
		if (relay?.tunnelHostname !== undefined || Date.now() >= deadline) {
			return relay;
		}
		await new Promise((resolve) => setTimeout(resolve, 1_000));
	}
};

export const activateServeRuntimeUpdate = async (input: {
	readonly dataDir: string;
	readonly version: string;
	readonly executable: string;
	readonly previous: ActiveServeRuntime | null;
	readonly installService: (executable: string) => Promise<unknown>;
	readonly waitUntilReachable: (timeoutMs?: number) => Promise<boolean>;
	readonly persist?: typeof writeActiveServeRuntime;
}): Promise<void> => {
	try {
		await input.installService(input.executable);
	} catch (cause) {
		if (input.previous !== null) {
			await input
				.installService(input.previous.executable)
				.catch(() => undefined);
		}
		throw cause;
	}
	if (!(await input.waitUntilReachable())) {
		if (input.previous !== null) {
			await input.installService(input.previous.executable);
			await input.waitUntilReachable(20_000);
			throw new Error(
				"The updated runtime failed its readiness check and Zuse restored the previous runtime.",
			);
		}
		throw new Error(
			"The updated runtime failed its readiness check. No previous runtime was available to restore.",
		);
	}
	await (input.persist ?? writeActiveServeRuntime)(input.dataDir, {
		version: input.version,
		executable: input.executable,
	});
};

export const removeServeRuntime = (dataDir: string): Promise<void> =>
	rm(join(dataDir, "runtime"), { recursive: true, force: true });

const clearServeSession = (): Promise<void> =>
	Effect.runPromise(
		Effect.gen(function* () {
			const store = yield* SessionStore;
			yield* store.withLock(store.clear());
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
		const seed = session;
		const refreshed = await Effect.runPromise(
			Effect.gen(function* () {
				const store = yield* SessionStore;
				return yield* refreshStoredSession(store, {
					clientId: workosClientId(env),
					seed,
					refreshSkewMs: 60_000,
				});
			}).pipe(Effect.provide(SessionStoreLive)),
		);
		session = refreshed;
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
	if (command.action === "help") {
		console.log(SERVE_HELP);
		return;
	}
	if (command.action === "version") {
		console.log(options.packageVersion ?? "0.0.0");
		return;
	}
	env.ZUSE_RUNTIME_VERSION = options.packageVersion ?? "0.0.0";
	env.ZUSE_RELAY_URL = env.ZUSE_RELAY_URL ?? DEFAULT_RELAY_URL;
	const dataDir = resolveServeDataDir(env, command.dataDir);
	env.ZUSE_USER_DATA = dataDir;
	const servicePaths = resolveServeServicePaths({ dataDir });
	// `start` installs from its own flags; every other action (notably
	// `update`) reuses the persisted flags so a re-install cannot silently
	// revert the binding or access choices the service was started with.
	const settings: ServeSettings =
		command.action === "start"
			? {
					sshManaged: command.sshManaged,
					tailscale: command.tailscale,
					noAccount: command.noAccount,
					lan: command.lan,
					host: command.host,
					port: command.port,
				}
			: await readServeSettings(dataDir);
	const installService = (executable: string) =>
		installServeService({
			executable,
			paths: servicePaths,
			relayUrl: env.ZUSE_RELAY_URL,
			...settings,
		});
	const enableTailnet = async (): Promise<string | null> => {
		if (!command.tailscale) return null;
		const port = command.port ?? Number(env.ZUSE_PORT ?? DEFAULT_SERVE_PORT);
		const options = { ownershipDir: dataDir, probe: probeZuseLoopback };
		const state = await setTailnetShareEnabled({
			enabled: true,
			port,
			...options,
		});
		if (state.enabled && state.managedBy === "zuse-serve") {
			// The route points at another live Zuse server (usually the desktop
			// app). Leave it alone; its auth and data belong to that instance, so
			// this daemon must not advertise the tailnet origin as its own.
			console.warn(
				"Tailscale Serve is routed to another Zuse instance on this machine; leaving it in place.",
			);
			return null;
		}
		if (!state.enabled) {
			throw new Error(
				state.detail ?? "Tailscale Serve could not share this computer.",
			);
		}
		console.log(`Tailnet    ${state.httpsUrl}`);
		return state.httpsUrl;
	};
	const authorizeAccount = (): Promise<{ readonly email: string } | null> =>
		requiresServeAccountAuthorization({
			sshManaged: command.sshManaged,
			noAccount: command.noAccount,
			cloudWorkspaceId: env.ZUSE_CLOUD_WORKSPACE_ID,
		})
			? Effect.runPromise(
					ensureServeSession({
						clientId: workosClientId(env),
						onPrompt: async (grant) => {
							console.log("Authorize this computer");
							console.log(`Code       ${grant.userCode}`);
							console.log(`Open       ${grant.verificationUriComplete}`);
							if (env.ZUSE_NO_OPEN !== "1") {
								openBrowser(grant.verificationUriComplete);
							}
						},
					}),
				)
			: Promise.resolve(null);

	if (command.action === "start" && command.foreground) {
		await authorizeAccount();
		if (
			shouldAutoLinkForeground({
				sshManaged: command.sshManaged,
				noAccount: command.noAccount,
				cloudWorkspaceId: env.ZUSE_CLOUD_WORKSPACE_ID,
			})
		)
			env.ZUSE_SERVE_AUTO_LINK = "1";
		const tailnetOrigin = await enableTailnet();
		runHeadlessServer(
			foregroundServeOptions(env, command, tailnetOrigin ?? undefined),
		);
		return;
	}

	if (command.action === "status") {
		await printStatus(await getServeServiceStatus(servicePaths), {
			json: command.json,
			dataDir,
			env,
			port: settings.port,
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
		await removeServeRuntime(dataDir);
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
		await activateServeRuntimeUpdate({
			dataDir,
			version,
			executable,
			previous,
			installService,
			waitUntilReachable: (timeoutMs) =>
				waitForReachability(env, timeoutMs, settings.port),
		});
		console.log(`Zuse Serve was updated to ${version}.`);
		return;
	}

	await mkdir(dataDir, { recursive: true, mode: 0o700 });
	await writeServeSettings(dataDir, settings);
	const session = await authorizeAccount();
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
			throw new UnsupportedServiceManagerError(
				`${cause.message} Zuse Serve requires a durable user service. Run with --foreground explicitly for a temporary session.`,
			);
		}
		throw cause;
	}
	const reachable = await waitForReachability(env, undefined, settings.port);
	if (!reachable) {
		throw new Error(
			"Zuse Serve was installed, but the background host did not become reachable. Run `zuse serve status --json` for diagnostics.",
		);
	}
	const tailnetOrigin = await enableTailnet();
	await writeActiveServeRuntime(dataDir, {
		version: options.packageVersion ?? "0.0.0",
		executable: installedExecutable,
	});
	const relay =
		session === null
			? readLocalRelayConfig(dataDir)
			: await waitForRelayConfig(dataDir, 30_000);
	const pairing = await readServePairingBootstrap(dataDir);

	console.log("");
	console.log("Zuse Serve is ready");
	console.log("");
	console.log(`Computer   ${hostname()}`);
	console.log("Status     Online");
	if (session !== null) console.log(`Account    ${session.email}`);
	const agents = await installedAgents();
	console.log(`Agents     ${agents.join(", ") || "None detected"}`);
	if (relay?.tunnelHostname !== undefined) {
		console.log(`Tunnel     https://${relay.tunnelHostname}`);
	}
	if (pairing !== null) {
		const browserBaseUrl =
			relay?.tunnelHostname !== undefined
				? `https://${relay.tunnelHostname}`
				: (tailnetOrigin ?? pairing.browserUrl.replace(/\/#pair=.*$/u, ""));
		const wsBaseUrl = wsBaseUrlForHttpBase(browserBaseUrl);
		console.log(`Browser    ${browserBaseUrl}`);
		if (pairing.code !== undefined) {
			console.log(`Code       ${formatPairingCodeForDisplay(pairing.code)}`);
			console.log(
				`Pair       ${buildConnectDeepLink({ wsBaseUrl, code: pairing.code })}`,
			);
		} else {
			console.log(`Pair       ${pairing.qrText}`);
		}
	}
	console.log(`Open       ${serveAppUrl(relay)}`);
};

export { foregroundArgs };
