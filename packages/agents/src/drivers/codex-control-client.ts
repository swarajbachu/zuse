import { createSharedResourcePool } from "@zuse/agents/kernel/shared-resource-pool";
import { CodexAppServerClient } from "./codex-app-server-client.ts";
import { isolatedProviderAccountEnv } from "./provider-account-env.ts";

interface CodexControlClientKey {
	readonly codexPath: string | null;
	readonly codexHome: string | null;
	readonly accountHome?: string;
}

const IDLE_TIMEOUT_MS = 5_000;
const STARTUP_TIMEOUT_MS = 10_000;
const keys = new Map<string, CodexControlClientKey>();
const pool = createSharedResourcePool<string, CodexAppServerClient>({
	create: (key) => {
		const config = keys.get(key);
		if (config === undefined) {
			return Promise.reject(
				new Error(`Unknown Codex control client key: ${key}`),
			);
		}
		return CodexAppServerClient.start({
			codexPath: config.codexPath,
			...(config.accountHome
				? {
						env: isolatedProviderAccountEnv(
							"codex",
							config.accountHome,
							process.env,
						),
						externalAuthProvider: null,
					}
				: {}),
			startupTimeoutMs: STARTUP_TIMEOUT_MS,
			onNotification: () => undefined,
			onServerRequest: (_request, respond) => respond({}),
		});
	},
	idleTimeoutMs: IDLE_TIMEOUT_MS,
});

const controlClientKey = (
	codexPath: string | null,
	accountHome?: string,
): string => {
	const pathKey =
		codexPath === null || /(^|[/\\])codex$/.test(codexPath)
			? "<default>"
			: codexPath;
	const key = JSON.stringify({
		path: pathKey,
		codexHome: accountHome ?? (process.env.CODEX_HOME?.trim() || null),
		accountHome,
	});
	const previous = keys.get(key);
	const config = {
		// Preserve an explicitly resolved binary path even though the default
		// command and an absolute path ending in `/codex` share one pool identity.
		codexPath: codexPath ?? previous?.codexPath ?? null,
		codexHome: accountHome ?? (process.env.CODEX_HOME?.trim() || null),
		accountHome,
	} satisfies CodexControlClientKey;
	keys.set(key, config);
	return key;
};

/**
 * Leases the shared read-only control-plane client. Interactive sessions and
 * operations requiring notifications must continue to own isolated clients.
 */
export const withCodexControlClient = async <Result>(
	codexPath: string | null,
	run: (client: CodexAppServerClient) => Promise<Result>,
	accountHome?: string,
): Promise<Result> => pool.use(controlClientKey(codexPath, accountHome), run);
