import * as net from "node:net";
import { DEFAULT_LOCAL_DESKTOP_PORT } from "@zuse/contracts";

const FALLBACK_PORT_ATTEMPTS = 10;

const canBindLoopback = (port: number): Promise<boolean> =>
	new Promise((resolve) => {
		const server = net.createServer();
		const finish = (available: boolean) => {
			server.removeAllListeners();
			if (server.listening) {
				server.close(() => resolve(available));
				return;
			}
			resolve(available);
		};
		server.once("error", () => finish(false));
		server.once("listening", () => finish(true));
		server.listen(port, "127.0.0.1");
	});

/**
 * The desktop relay is useful for paired devices, but it must never stop the
 * local Electron application from opening. A user can legitimately have an
 * unrelated development server on the conventional relay port, so packaged
 * builds move to a nearby available port before booting the shared runtime.
 *
 * An explicit port remains authoritative: it is normally supplied by tests or
 * operators who need a stable endpoint and should fail loudly if unavailable.
 */
export const resolveDesktopRelayPort = async (input: {
	readonly configuredPort: string | undefined;
	/** Test seam; production always uses the conventional relay port. */
	readonly defaultPort?: number;
}): Promise<{ readonly port: number; readonly fellBack: boolean }> => {
	const configured = input.configuredPort?.trim();
	if (configured !== undefined && configured.length > 0) {
		const port = Number(configured);
		if (Number.isInteger(port) && port >= 0 && port <= 65_535) {
			return { port, fellBack: false };
		}
		throw new Error("ZUSE_DESKTOP_WS_PORT must be an integer from 0 to 65535");
	}

	const defaultPort = input.defaultPort ?? DEFAULT_LOCAL_DESKTOP_PORT;
	for (let offset = 0; offset < FALLBACK_PORT_ATTEMPTS; offset += 1) {
		const port = defaultPort + offset;
		if (await canBindLoopback(port)) return { port, fellBack: offset > 0 };
	}

	// Asking the OS for a port is the final fallback when the conventional
	// range is busy. The selected port is passed through the runtime's LAN
	// config, so pairing and relay registration advertise the same endpoint.
	const server = net.createServer();
	const port = await new Promise<number>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			const address = server.address();
			if (address === null || typeof address === "string") {
				reject(new Error("Could not allocate a loopback relay port"));
				return;
			}
			resolve(address.port);
		});
	});
	await new Promise<void>((resolve, reject) =>
		server.close((error) => (error === undefined ? resolve() : reject(error))),
	);
	return { port, fellBack: true };
};
