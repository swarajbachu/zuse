import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Kiro CLI stores the live OIDC token in its app-support SQLite DB under
 * `auth_kv` (key is historically misspelled `kirocli:odic:token`). The SSO
 * cache files under `~/.aws/sso/cache/kiro-auth-token*.json` lag behind and
 * may be expired even while the CLI is still authenticated.
 *
 * SQLite access mirrors `packages/tokenmaxer/src/sources/sqlite.ts`: Bun uses
 * `bun:sqlite`, Node/Electron uses `node:sqlite`.
 */

const KIRO_TOKEN_KEY = "kirocli:odic:token";
const KIRO_PROFILE_STATE_KEY = "api.codewhisperer.profile";

export interface KiroOidcToken {
	readonly accessToken: string;
	readonly refreshToken: string | null;
	readonly expiresAt: string | null;
	readonly region: string;
	readonly startUrl: string | null;
}

export interface KiroAuthContext {
	readonly token: KiroOidcToken;
	readonly profileArn: string | null;
	readonly region: string;
}

interface SqliteHandle {
	prepare(sql: string): { get(...params: unknown[]): unknown };
	close(): void;
}

const kiroCliDataDir = (): string => {
	if (process.platform === "darwin") {
		return join(
			homedir(),
			"Library",
			"Application Support",
			"kiro-cli",
			"data.sqlite3",
		);
	}
	if (process.platform === "win32") {
		const appData = process.env.APPDATA?.trim();
		if (appData && appData.length > 0) {
			return join(appData, "kiro-cli", "data.sqlite3");
		}
	}
	const xdg = process.env.XDG_DATA_HOME?.trim();
	const base = xdg && xdg.length > 0 ? xdg : join(homedir(), ".local", "share");
	return join(base, "kiro-cli", "data.sqlite3");
};

const openReadonlyDatabase = (path: string): SqliteHandle | null => {
	try {
		const require = createRequire(import.meta.url);
		if (process.versions.bun !== undefined) {
			const mod = require("bun:sqlite") as {
				Database: new (
					filename: string,
					options?: { readonly?: boolean },
				) => SqliteHandle;
			};
			return new mod.Database(path, { readonly: true });
		}
		const { DatabaseSync } =
			require("node:sqlite") as typeof import("node:sqlite");
		return new DatabaseSync(path, { readOnly: true });
	} catch {
		return null;
	}
};

const readKv = (
	db: SqliteHandle,
	table: "auth_kv" | "state",
	key: string,
): string | null => {
	try {
		const row = db
			.prepare(`SELECT value FROM ${table} WHERE key = ?`)
			.get(key) as { value?: unknown } | undefined;
		if (row === undefined || row.value === undefined || row.value === null) {
			return null;
		}
		if (typeof row.value === "string") return row.value;
		if (row.value instanceof Uint8Array) {
			return Buffer.from(row.value).toString("utf-8");
		}
		if (
			typeof row.value === "object" &&
			row.value !== null &&
			"toString" in row.value
		) {
			return String(row.value);
		}
		return null;
	} catch {
		return null;
	}
};

const parseToken = (raw: string): KiroOidcToken | null => {
	try {
		const parsed = JSON.parse(raw) as Record<string, unknown>;
		const accessToken =
			typeof parsed.access_token === "string"
				? parsed.access_token
				: typeof parsed.accessToken === "string"
					? parsed.accessToken
					: null;
		if (accessToken === null || accessToken.length === 0) return null;
		const region =
			typeof parsed.region === "string" && parsed.region.length > 0
				? parsed.region
				: "us-east-1";
		return {
			accessToken,
			refreshToken:
				typeof parsed.refresh_token === "string"
					? parsed.refresh_token
					: typeof parsed.refreshToken === "string"
						? parsed.refreshToken
						: null,
			expiresAt:
				typeof parsed.expires_at === "string"
					? parsed.expires_at
					: typeof parsed.expiresAt === "string"
						? parsed.expiresAt
						: null,
			region,
			startUrl:
				typeof parsed.start_url === "string"
					? parsed.start_url
					: typeof parsed.startUrl === "string"
						? parsed.startUrl
						: null,
		};
	} catch {
		return null;
	}
};

const parseProfileArn = (raw: string | null): string | null => {
	if (raw === null) return null;
	try {
		const parsed = JSON.parse(raw) as { arn?: unknown };
		return typeof parsed.arn === "string" && parsed.arn.length > 0
			? parsed.arn
			: null;
	} catch {
		const trimmed = raw.replace(/^"|"$/g, "").trim();
		return trimmed.startsWith("arn:") ? trimmed : null;
	}
};

const tokenExpired = (token: KiroOidcToken, skewMs = 60_000): boolean => {
	if (token.expiresAt === null) return false;
	const ms = Date.parse(token.expiresAt);
	if (Number.isNaN(ms)) return false;
	return ms <= Date.now() + skewMs;
};

/**
 * Best-effort refresh: `kiro-cli whoami` re-writes auth_kv when the refresh
 * token is still valid. Synchronous and short-timeout so usage/inventory
 * probes stay snappy.
 */
const tryRefreshViaCli = (kiroPath = "kiro-cli"): void => {
	try {
		spawnSync(kiroPath, ["whoami"], {
			stdio: "ignore",
			timeout: 8_000,
			env: process.env,
		});
	} catch {
		// ignore — caller will surface no-credentials / expired
	}
};

export const readKiroAuthContext = (
	options: {
		readonly refreshIfExpired?: boolean;
		readonly kiroPath?: string;
	} = {},
): KiroAuthContext | null => {
	const refreshIfExpired = options.refreshIfExpired ?? true;
	const readOnce = (): KiroAuthContext | null => {
		const db = openReadonlyDatabase(kiroCliDataDir());
		if (db === null) return null;
		try {
			const tokenRaw = readKv(db, "auth_kv", KIRO_TOKEN_KEY);
			if (tokenRaw === null) return null;
			const token = parseToken(tokenRaw);
			if (token === null) return null;
			const profileArn = parseProfileArn(
				readKv(db, "state", KIRO_PROFILE_STATE_KEY),
			);
			return {
				token,
				profileArn,
				region: token.region,
			};
		} finally {
			try {
				db.close();
			} catch {
				// ignore
			}
		}
	};

	const first = readOnce();
	if (first === null) return null;
	if (!tokenExpired(first.token) || !refreshIfExpired) return first;

	tryRefreshViaCli(options.kiroPath ?? "kiro-cli");
	return readOnce() ?? first;
};

export const kiroManagementEndpoint = (region: string): string =>
	`https://management.${region}.kiro.dev`;

export const kiroControlPlaneRequest = async <T>(
	auth: KiroAuthContext,
	operation: string,
	body: Record<string, unknown>,
	timeoutMs = 8_000,
): Promise<T> => {
	const endpoint = kiroManagementEndpoint(auth.region);
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	try {
		const response = await fetch(endpoint, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${auth.token.accessToken}`,
				"Content-Type": "application/x-amz-json-1.0",
				"x-amz-target": `KiroControlPlaneBearerService.${operation}`,
				"User-Agent": "zuse-kiro-client/1.0",
			},
			body: JSON.stringify(body),
			signal: controller.signal,
		});
		const text = await response.text();
		let json: unknown = null;
		try {
			json = text.length > 0 ? JSON.parse(text) : null;
		} catch {
			throw new Error(
				`Kiro ${operation} returned non-JSON (${response.status}): ${text.slice(0, 200)}`,
			);
		}
		if (!response.ok) {
			const message =
				json !== null &&
				typeof json === "object" &&
				"message" in json &&
				typeof (json as { message: unknown }).message === "string"
					? (json as { message: string }).message
					: `HTTP ${response.status}`;
			const err = new Error(`Kiro ${operation} failed: ${message}`);
			(err as Error & { status?: number }).status = response.status;
			throw err;
		}
		return json as T;
	} finally {
		clearTimeout(timer);
	}
};
