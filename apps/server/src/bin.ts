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
import { pathToFileURL } from "node:url";

import { NodeRuntime } from "@effect/platform-node";
import { Effect, Layer } from "effect";

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

export const runHeadlessServer = (): void => {
	const port = Number(process.env.ZUSE_PORT ?? 8787);
	const host = process.env.ZUSE_HOST ?? "127.0.0.1";
	const userData = resolveUserData();
	const policy = resolveAuthPolicy(host);
	const advertisedHost =
		process.env.ZUSE_ADVERTISED_HOST ??
		(host === "0.0.0.0" || host === "::" ? null : host);
	const pairingBootstrap = process.env.ZUSE_ENABLE_PAIRING === "1";

	const layer = makeMainLayer({
		userData,
		// Headless has no native dialog; surfacing the prompt to a connected client
		// is a later refinement. Returning null is the documented contract.
		folderPicker: { pick: () => Effect.succeed(null) },
		serverProtocol: wsServerProtocolLayer({
			port,
			host,
			onListening:
				process.env.ZUSE_SERVER_READY_STDOUT === "1"
					? (address) =>
							console.log(`ZUSE_SERVER_READY ${JSON.stringify(address)}`)
					: undefined,
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
			convexRedirectUri:
				process.env.ZUSE_CONVEX_REDIRECT_URI ??
				"http://127.0.0.1/convex/callback",
			onConvexCallbackUrl: () => Effect.void,
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
	runHeadlessServer();
}
