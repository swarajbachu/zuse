#!/usr/bin/env node
/**
 * Standalone (headless) server entrypoint — `zuse serve`. Builds the host-shell
 * deps without Electron: file-backed AppPaths resolved from env/XDG, a no-op
 * FolderPicker, and the WebSocket transport. This same binary is what runs on
 * an SSH dev-box and (later) on a cloud container — there is no laptop
 * assumption anywhere in `@zuse/server` (ADR 0007).
 *
 * Per ADR 0007, transport modules live under `transports/` — never inside a
 * service domain. The factory (`makeMainLayer`) is re-exported so the Electron
 * shim and tests keep a stable import surface; importing this module is
 * side-effect free (the server only boots when the file is the process entry).
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

import { NodeRuntime } from "@effect/platform-node";
import { DEFAULT_LOCAL_DESKTOP_PORT } from "@zuse/contracts";
import { Effect, Layer } from "effect";
import type { LanAuthPolicy } from "./lan-auth/policy.ts";
import { resolveAuthPolicy } from "./lan-auth/policy.ts";
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
	const advertisedHost =
		process.env.ZUSE_ADVERTISED_HOST ??
		(host === "0.0.0.0" || host === "::" ? null : host);
	const pairingBootstrap = options.pairing;

	const layer = makeMainLayer({
		userData,
		// Headless has no native dialog; surfacing the prompt to a connected client
		// is a later refinement. Returning null is the documented contract.
		folderPicker: { pick: () => Effect.succeed(null) },
		serverProtocol: wsServerProtocolLayer({
			port,
			host,
			staticDir: options.staticDir,
			onPairing: options.open
				? ({ browserUrl }) => openBrowser(browserUrl)
				: undefined,
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
		// login (clients authenticate to the environment via pairing/relay tokens).
		authShell: {
			redirectUri:
				process.env.ZUSE_AUTH_REDIRECT_URI ?? "http://127.0.0.1/auth/callback",
			open: () => Effect.void,
			onCallbackUrl: () => Effect.void,
		},
		lanAuth: { policy, advertisedHost, port, pairingBootstrap },
	});

	NodeRuntime.runMain(
		Layer.launch(layer) as Effect.Effect<never, unknown, never>,
	);
};

// Only boot when this file is the process entrypoint, so the re-export above
// stays import-safe (Vite HMR, tests, the Electron shim).
const entry = process.argv[1];
if (entry && import.meta.url === pathToFileURL(entry).href) {
	try {
		runHeadlessServer(parseServeOptions(process.argv.slice(2)));
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
	}
}
