#!/usr/bin/env node
/**
 * Standalone (headless) server entrypoint — `zuse serve`. Builds the host-shell
 * deps without Electron: file-backed AppPaths resolved from env/XDG, a no-op
 * FolderPicker, and the WebSocket transport. This same binary is what runs on
 * an SSH dev-box and (later) on a cloud container — there is no laptop
 * assumption anywhere in `@zusehq/server` (ADR 0007).
 *
 * Per ADR 0007, transport modules live under `transports/` — never inside a
 * service domain. The factory (`makeMainLayer`) is re-exported so the Electron
 * shim and tests keep a stable import surface; importing this module is
 * side-effect free (the server only boots when the file is the process entry).
 */
import { spawn } from "node:child_process";
import { existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

import { NodeRuntime } from "@effect/platform-node";
import { DEFAULT_LOCAL_DESKTOP_PORT } from "@zuse/contracts";
import { firstReachableIpv4 } from "@zuse/utils/network-address";
import { Effect, Layer, Redacted } from "effect";
import type { LanAuthPolicy } from "./lan-auth/policy.ts";
import { resolveAuthPolicy } from "./lan-auth/policy.ts";
import { makeFileCredentialsService } from "./provider/layers/file-credentials-service.ts";
import { makeMainLayer } from "./runtime.ts";
import { wsServerProtocolLayer } from "./transports/ws.ts";

export { type MainLayerDeps, makeMainLayer } from "./runtime.ts";

/**
 * Where persistence files (zuse.sqlite, attachments, logs) live on a headless
 * host. Electron uses `app.getPath("userData")`; here we honor an explicit
 * `ZUSE_USER_DATA` override, else `$XDG_DATA_HOME/zuse`, else
 * `~/.local/share/zuse`.
 */
const resolveUserData = (): string => {
	if (process.env.ZUSE_USER_DATA) return process.env.ZUSE_USER_DATA;
	const home = process.env.HOME ?? process.env.USERPROFILE ?? ".";
	const xdg = process.env.XDG_DATA_HOME ?? `${home}/.local/share`;
	return `${xdg}/zuse`;
};

export type ServeOptions = {
	readonly host: string;
	readonly port: number;
	readonly dataDir: string;
	readonly staticDir: string | undefined;
	readonly open: boolean;
	readonly policy: LanAuthPolicy;
	readonly pairing: boolean;
	readonly pairingPublicBaseUrl?: string;
	readonly trustProxy?: boolean;
	readonly apiEnabled?: boolean;
};

const parsePort = (raw: string): number => {
	const port = Number(raw);
	if (!Number.isInteger(port) || port < 0 || port > 65_535) {
		throw new Error(`--port must be an integer from 0 to 65535, got ${raw}`);
	}
	return port;
};

const defaultStaticDir = fileURLToPath(
	new URL("../dist/client", import.meta.url),
);

export const parseServeOptions = (
	argv: ReadonlyArray<string>,
	env: NodeJS.ProcessEnv = process.env,
): ServeOptions => {
	const command = argv[0] ?? "serve";
	if (command !== "serve") {
		throw new Error(
			`Unknown command "${command}". Usage: zuse serve [options]`,
		);
	}
	const parsed = parseArgs({
		args: [...argv.slice(1)],
		allowPositionals: false,
		strict: true,
		allowNegative: true,
		options: {
			host: { type: "string" },
			port: { type: "string" },
			"data-dir": { type: "string" },
			"static-dir": { type: "string" },
			open: { type: "boolean", default: false },
			auth: { type: "string" },
			pairing: { type: "boolean", default: true },
		},
	});
	const host = parsed.values.host ?? env.ZUSE_HOST ?? "127.0.0.1";
	const port = parsePort(
		parsed.values.port ?? env.ZUSE_PORT ?? String(DEFAULT_LOCAL_DESKTOP_PORT),
	);
	const requestedPolicy = parsed.values.auth ?? env.ZUSE_AUTH_POLICY ?? "auto";
	if (
		!(["auto", "local", "protected"] as const).includes(
			requestedPolicy as never,
		)
	) {
		throw new Error(
			`--auth must be auto, local, or protected, got ${requestedPolicy}`,
		);
	}
	const policy =
		requestedPolicy === "auto"
			? resolveAuthPolicy(host)
			: (requestedPolicy as LanAuthPolicy);
	if (policy === "local" && resolveAuthPolicy(host) === "protected") {
		throw new Error(
			"Refusing unauthenticated access on a non-loopback host. Use --auth protected.",
		);
	}
	const selectedStaticDir =
		parsed.values["static-dir"] ?? env.ZUSE_STATIC_DIR ?? defaultStaticDir;
	if (
		(parsed.values["static-dir"] !== undefined ||
			env.ZUSE_STATIC_DIR !== undefined) &&
		!existsSync(selectedStaticDir)
	) {
		throw new Error(
			`Static client directory does not exist: ${selectedStaticDir}`,
		);
	}
	return {
		host,
		port,
		dataDir:
			parsed.values["data-dir"] ?? env.ZUSE_USER_DATA ?? resolveUserData(),
		staticDir: existsSync(selectedStaticDir) ? selectedStaticDir : undefined,
		open: parsed.values.open ?? false,
		policy,
		pairing: (parsed.values.pairing ?? true) && env.ZUSE_ENABLE_PAIRING !== "0",
	};
};

const openBrowser = (url: string): void => {
	const [command, args] =
		process.platform === "darwin"
			? (["open", [url]] as const)
			: process.platform === "win32"
				? (["cmd", ["/c", "start", "", url]] as const)
				: (["xdg-open", [url]] as const);
	const child = spawn(command, args, { detached: true, stdio: "ignore" });
	child.unref();
};

export const runHeadlessServer = (
	options: ServeOptions = parseServeOptions(["serve"]),
): void => {
	const { port, host, dataDir: userData, policy } = options;
	const cliHost = host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host;
	// A wildcard binding is reachable on the LAN, so advertise the machine's
	// LAN address; a specific binding advertises exactly what it listens on.
	const advertisedHost =
		process.env.ZUSE_ADVERTISED_HOST ??
		(host === "0.0.0.0" || host === "::" ? firstReachableIpv4() : host);
	const pairingBootstrap = options.pairing;
	const enrollmentTokenFile = process.env.ZUSE_ENROLLMENT_TOKEN_FILE;
	const enrollmentToken =
		process.env.ZUSE_ENROLLMENT_TOKEN ??
		(enrollmentTokenFile === undefined
			? undefined
			: readFileSync(enrollmentTokenFile, "utf8").trim());
	const workspaceId = process.env.ZUSE_CLOUD_WORKSPACE_ID;
	const machineId = process.env.ZUSE_MACHINE_ID;
	const apiUrl = process.env.ZUSE_API_URL?.replace(/\/+$/u, "");
	const apiIssuer = process.env.ZUSE_API_ISSUER?.replace(/\/+$/u, "");
	const cloudEnrollment =
		enrollmentToken !== undefined &&
		machineId !== undefined &&
		workspaceId === undefined &&
		apiUrl !== undefined &&
		apiIssuer !== undefined
			? {
					machineId,
					apiUrl,
					apiIssuer,
					token: Redacted.make(enrollmentToken),
					tokenFile: enrollmentTokenFile,
					label: process.env.ZUSE_MACHINE_LABEL,
					port,
				}
			: undefined;
	const runtimeBootTokenFile = process.env.ZUSE_RUNTIME_BOOT_TOKEN_FILE;
	const runtimeBootToken =
		process.env.ZUSE_RUNTIME_BOOT_TOKEN ??
		(runtimeBootTokenFile === undefined
			? undefined
			: readFileSync(runtimeBootTokenFile, "utf8").trim());
	const cloudWorkspaceRoot = process.env.ZUSE_CLOUD_WORKSPACE_ROOT;
	const cloudWorkspaceRuntime =
		workspaceId !== undefined &&
		apiUrl !== undefined &&
		runtimeBootToken !== undefined &&
		cloudWorkspaceRoot !== undefined
			? {
					workspaceId,
					apiUrl,
					bootToken: Redacted.make(runtimeBootToken),
					bootTokenFile: runtimeBootTokenFile,
					localPort: port,
					workspaceRoot: cloudWorkspaceRoot,
				}
			: undefined;
	delete process.env.ZUSE_ENROLLMENT_TOKEN;
	delete process.env.ZUSE_RUNTIME_BOOT_TOKEN;

	const layer = makeMainLayer({
		userData,
		telemetryIdentity: { kind: "serve", instance: `${host}:${port}` },
		// Headless has no native dialog; surfacing the prompt to a connected client
		// is a later refinement. Returning null is the documented contract.
		folderPicker: { pick: () => Effect.succeed(null) },
		serverProtocol: wsServerProtocolLayer({
			port,
			host,
			staticDir: options.staticDir,
			sshBridge: process.env.ZUSE_MACHINE_RUNTIME_ROLE === "cloud-environment",
			pairingPublicBaseUrl: options.pairingPublicBaseUrl,
			apiEnabled: options.apiEnabled,
			trustProxy: options.trustProxy,
			onPairing: (pairing) => {
				// Persist the boot pairing details so the serve CLI can print
				// real links without scraping service logs.
				try {
					writeFileSync(
						join(userData, "pairing.json"),
						`${JSON.stringify({
							browserUrl: pairing.browserUrl,
							baseUrl: pairing.baseUrl,
							qrText: pairing.qrText,
							code: pairing.code,
							expiresAt: pairing.expiresAt.toISOString(),
						})}\n`,
						{ mode: 0o600 },
					);
				} catch {
					// Best-effort: links still print to stdout.
				}
				if (options.open) openBrowser(pairing.browserUrl);
			},
			onListening: (address) => {
				const browserHost =
					address.host === "0.0.0.0" || address.host === "::"
						? "localhost"
						: address.host;
				const browserUrl = `http://${browserHost}:${address.port}`;
				console.log(`Zuse Serve: ${browserUrl}`);
				console.log(
					`Access: ${policy === "protected" ? "pairing required" : "loopback only"}`,
				);
				console.log(
					`Client: ${options.staticDir ?? "not bundled (pass --static-dir)"}`,
				);
				if (process.env.ZUSE_SERVER_READY_STDOUT === "1") {
					console.log(`ZUSE_SERVER_READY ${JSON.stringify(address)}`);
				}
				if (options.open && policy === "local") openBrowser(browserUrl);
			},
		}),
		// Inert AuthShell for headless boot. The WorkOS deep-link flow needs a host
		// to open a browser and receive the callback; a headless server's proper
		// variant is a loopback-HTTP listener, wired with the auth/pairing work.
		// Until then this no-op satisfies the seam without offering server-side
		// login (clients authenticate to the environment via pairing/api tokens).
		authShell: {
			redirectUri:
				process.env.ZUSE_AUTH_REDIRECT_URI ?? "http://127.0.0.1/auth/callback",
			open: () => Effect.void,
			onCallbackUrl: () => Effect.void,
		},
		credentialsLayer: makeFileCredentialsService(userData),
		cloudEnrollment,
		cloudWorkspaceRuntime,
		machineRuntimeRole:
			process.env.ZUSE_MACHINE_RUNTIME_ROLE === "cloud-environment"
				? "cloud-environment"
				: "control-plane",
		lanAuth: { policy, advertisedHost, port, pairingBootstrap },
		...(port === 0
			? {}
			: {
					cliAccess: {
						path: join(userData, "cli-access.json"),
						wsUrl: `ws://${cliHost}:${port}/rpc`,
					},
				}),
		apiEnabled: options.apiEnabled !== false,
		autoApiLink:
			process.env.ZUSE_SERVE_AUTO_LINK === "1"
				? {
						apiUrl: process.env.ZUSE_API_URL ?? "https://api.zuse.sh",
						label: process.env.ZUSE_COMPUTER_NAME,
					}
				: undefined,
	});

	NodeRuntime.runMain(
		Layer.launch(layer) as Effect.Effect<never, unknown, never>,
	);
};

// Only boot when this file is the process entrypoint, so the re-export above
// stays import-safe (Vite HMR, tests, the Electron shim).
export const isProcessEntrypoint = (
	entry: string | undefined,
	moduleUrl = import.meta.url,
): boolean => {
	if (entry === undefined) return false;
	try {
		return realpathSync(entry) === realpathSync(fileURLToPath(moduleUrl));
	} catch {
		return pathToFileURL(entry).href === moduleUrl;
	}
};

const entry = process.argv[1];
if (isProcessEntrypoint(entry)) {
	try {
		runHeadlessServer(parseServeOptions(process.argv.slice(2)));
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
	}
}
