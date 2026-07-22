import {
	closeSync,
	mkdirSync,
	openSync,
	readFileSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { resolve } from "node:path";

const RENDERER_BASE_PORT = 5733;
const WEBSOCKET_BASE_PORT = 8788;

const parseInteger = (label, value) => {
	const parsed = Number(value);
	if (!Number.isInteger(parsed))
		throw new Error(`[dev] ${label} must be an integer, got ${value}`);
	return parsed;
};

export const parseDevArguments = (argv) => {
	let instance;
	let dryRun = false;
	for (let index = 0; index < argv.length; index += 1) {
		const argument = argv[index];
		if (argument === "--dry-run") {
			dryRun = true;
			continue;
		}
		if (argument === "--instance") {
			instance = argv[index + 1];
			index += 1;
			continue;
		}
		if (argument.startsWith("--instance=")) {
			instance = argument.slice("--instance=".length);
			continue;
		}
		throw new Error(`[dev] unknown argument: ${argument}`);
	}
	return { instance, dryRun };
};

const validateInstance = (instance) => {
	if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,47}$/u.test(instance)) {
		throw new Error(
			`[dev] instance must match [a-zA-Z0-9][a-zA-Z0-9_-]{0,47}, got ${instance}`,
		);
	}
	return instance;
};

const hashInstance = (value) => {
	let hash = 2_166_136_261;
	for (const character of value) {
		hash ^= character.codePointAt(0) ?? 0;
		hash = Math.imul(hash, 16_777_619);
	}
	return hash >>> 0;
};

const validatePort = (label, port) => {
	if (port <= 0 || port > 65_535) {
		throw new Error(
			`[dev] ${label} must be a TCP port from 1 to 65535, got ${port}`,
		);
	}
	return port;
};

const instanceResources = (repoRoot, instance) => {
	const instanceRoot = resolve(repoRoot, ".zuse", "dev-instances", instance);
	return {
		instanceRoot,
		userDataDir: resolve(instanceRoot, "user-data"),
		packDir: resolve(
			repoRoot,
			"apps",
			"desktop",
			".dev-instances",
			instance,
			"dist-electron",
		),
	};
};

export const initialDevInstance = ({ argv, env, repoRoot }) => {
	const parsed = parseDevArguments(argv);
	const requestedInstance = parsed.instance ?? env.ZUSE_DEV_INSTANCE;
	const explicitOffset = env.ZUSE_PORT_OFFSET;
	const offset =
		explicitOffset !== undefined
			? parseInteger("ZUSE_PORT_OFFSET", explicitOffset)
			: requestedInstance !== undefined
				? hashInstance(validateInstance(requestedInstance)) % 1_000
				: 0;
	if (offset < 0)
		throw new Error(`[dev] ZUSE_PORT_OFFSET cannot be negative, got ${offset}`);

	const rendererExplicit = env.PORT !== undefined;
	const websocketExplicit = env.ZUSE_DESKTOP_WS_PORT !== undefined;
	const rendererPort = validatePort(
		"PORT",
		rendererExplicit
			? parseInteger("PORT", env.PORT)
			: RENDERER_BASE_PORT + offset,
	);
	const websocketPort = validatePort(
		"ZUSE_DESKTOP_WS_PORT",
		websocketExplicit
			? parseInteger("ZUSE_DESKTOP_WS_PORT", env.ZUSE_DESKTOP_WS_PORT)
			: WEBSOCKET_BASE_PORT + offset,
	);
	const instance = validateInstance(
		requestedInstance ?? `port-${rendererPort}`,
	);
	return {
		instance,
		automaticInstance: requestedInstance === undefined,
		repoRoot,
		dryRun: parsed.dryRun,
		rendererPort,
		websocketPort,
		rendererExplicit,
		websocketExplicit,
		...instanceResources(repoRoot, instance),
	};
};

export const withScannedPorts = async (
	initial,
	isAvailable,
	reservePair = async () => () => {},
) => {
	let rendererPort = initial.rendererPort;
	let websocketPort = initial.websocketPort;
	for (let attempts = 0; attempts < 200; attempts += 1) {
		const [rendererAvailable, websocketAvailable] = await Promise.all([
			isAvailable(rendererPort, "renderer"),
			isAvailable(websocketPort, "websocket"),
		]);
		const releaseReservation =
			rendererAvailable && websocketAvailable
				? await reservePair(rendererPort, websocketPort)
				: null;
		if (
			rendererAvailable &&
			websocketAvailable &&
			releaseReservation !== null
		) {
			if (!initial.automaticInstance) {
				const portsShifted =
					rendererPort !== initial.rendererPort ||
					websocketPort !== initial.websocketPort;
				return {
					...initial,
					...(portsShifted
						? instanceResources(
								initial.repoRoot,
								`${initial.instance}-p${rendererPort}`,
							)
						: {}),
					rendererPort,
					websocketPort,
					releaseReservation,
				};
			}
			const instance = validateInstance(`port-${rendererPort}`);
			return {
				...initial,
				...instanceResources(initial.repoRoot, instance),
				instance,
				rendererPort,
				websocketPort,
				releaseReservation,
			};
		}
		if (
			(initial.rendererExplicit && !rendererAvailable) ||
			(initial.websocketExplicit && !websocketAvailable) ||
			((initial.rendererExplicit || initial.websocketExplicit) &&
				rendererAvailable &&
				websocketAvailable &&
				releaseReservation === null)
		) {
			const occupied = [
				!rendererAvailable ? `renderer ${rendererPort}` : null,
				!websocketAvailable ? `websocket ${websocketPort}` : null,
			]
				.filter(Boolean)
				.join(" and ");
			throw new Error(
				`[dev] explicit ${occupied || `${rendererPort}/${websocketPort}`} port is unavailable`,
			);
		}
		if (!initial.rendererExplicit) rendererPort += 1;
		if (!initial.websocketExplicit) websocketPort += 1;
		validatePort("renderer scan", rendererPort);
		validatePort("websocket scan", websocketPort);
	}
	throw new Error(
		"[dev] could not find an available renderer/WebSocket port pair",
	);
};

/**
 * Atomically reserve a development port pair across concurrent runner
 * processes. Stale locks are reclaimed after confirming their owner exited.
 */
export const reserveDevPortPair = (repoRoot, rendererPort, websocketPort) => {
	const lockDirectory = resolve(repoRoot, ".zuse", "dev-port-locks");
	mkdirSync(lockDirectory, { recursive: true });
	const lockPath = resolve(
		lockDirectory,
		`${rendererPort}-${websocketPort}.lock`,
	);
	const acquire = () => {
		try {
			const descriptor = openSync(lockPath, "wx");
			try {
				writeFileSync(descriptor, String(process.pid));
			} finally {
				closeSync(descriptor);
			}
			let released = false;
			return () => {
				if (released) return;
				released = true;
				try {
					unlinkSync(lockPath);
				} catch (error) {
					if (
						!(
							error instanceof Error &&
							"code" in error &&
							error.code === "ENOENT"
						)
					)
						throw error;
				}
			};
		} catch (error) {
			if (
				!(error instanceof Error && "code" in error && error.code === "EEXIST")
			)
				throw error;
			let owner = Number.NaN;
			try {
				owner = Number(readFileSync(lockPath, "utf8"));
			} catch {
				return null;
			}
			try {
				process.kill(owner, 0);
				return null;
			} catch (ownerError) {
				if (
					ownerError instanceof Error &&
					"code" in ownerError &&
					ownerError.code === "EPERM"
				)
					return null;
				try {
					unlinkSync(lockPath);
				} catch {
					return null;
				}
				return acquire();
			}
		}
	};
	return acquire();
};

export const devInstanceDiagnostics = (instance, host = "localhost") => ({
	instance: instance.instance,
	rendererPort: instance.rendererPort,
	websocketPort: instance.websocketPort,
	rendererUrl: `http://${host}:${instance.rendererPort}`,
	dataDirectory: instance.userDataDir,
	packDirectory: instance.packDir,
});
