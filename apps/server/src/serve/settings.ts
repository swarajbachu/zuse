import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * Flags a durable `zuse serve start` was installed with. Persisted in the
 * data dir so `zuse serve update` re-installs the service with the same
 * binding and access choices instead of silently reverting them to defaults.
 */
export interface ServeSettings {
	readonly sshManaged?: boolean;
	readonly tailscale?: boolean;
	readonly noAccount?: boolean;
	readonly lan?: boolean;
	readonly host?: string;
	readonly port?: number;
}

const settingsPath = (dataDir: string): string =>
	join(dataDir, "serve-settings.json");

export const readServeSettings = async (
	dataDir: string,
): Promise<ServeSettings> => {
	try {
		const raw = JSON.parse(await readFile(settingsPath(dataDir), "utf8")) as {
			readonly sshManaged?: unknown;
			readonly tailscale?: unknown;
			readonly noAccount?: unknown;
			readonly lan?: unknown;
			readonly host?: unknown;
			readonly port?: unknown;
		};
		return {
			sshManaged: raw.sshManaged === true,
			tailscale: raw.tailscale === true,
			noAccount: raw.noAccount === true,
			lan: raw.lan === true,
			host: typeof raw.host === "string" ? raw.host : undefined,
			port:
				typeof raw.port === "number" &&
				Number.isInteger(raw.port) &&
				raw.port >= 1 &&
				raw.port <= 65_535
					? raw.port
					: undefined,
		};
	} catch {
		return {};
	}
};

export const writeServeSettings = async (
	dataDir: string,
	settings: ServeSettings,
): Promise<void> => {
	await mkdir(dataDir, { recursive: true, mode: 0o700 });
	await writeFile(
		settingsPath(dataDir),
		`${JSON.stringify(settings, null, "\t")}\n`,
		{ mode: 0o600 },
	);
};
