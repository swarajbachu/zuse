import { spawnSync } from "node:child_process";
import {
	copyFileSync,
	existsSync,
	mkdtempSync,
	readFileSync,
	rmSync,
} from "node:fs";
import { createRequire } from "node:module";
import { homedir, tmpdir } from "node:os";
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

export const kiroCliDataDir = (): string => {
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

const ssoCacheTokenPaths = (): ReadonlyArray<string> => {
	const cacheDir = join(homedir(), ".aws", "sso", "cache");
	return [
		join(cacheDir, "kiro-auth-token-cli.json"),
		join(cacheDir, "kiro-auth-token.json"),
	];
};

/** Common install locations when Electron's PATH is incomplete. */
const kiroCliCandidatePaths = (): ReadonlyArray<string> => {
	const home = homedir();
	const out: string[] = [];
	if (process.platform === "darwin") {
		out.push(
			"/Applications/Kiro CLI.app/Contents/MacOS/kiro-cli",
			join(home, "Applications/Kiro CLI.app/Contents/MacOS/kiro-cli"),
			join(home, ".local/bin/kiro-cli"),
		);
	} else if (process.platform === "win32") {
		const local = process.env.LOCALAPPDATA?.trim();
		if (local) out.push(join(local, "Programs", "Kiro CLI", "kiro-cli.exe"));
	} else {
		out.push(
			join(home, ".local/bin/kiro-cli"),
			"/usr/local/bin/kiro-cli",
			"/usr/bin/kiro-cli",
		);
	}
	return out;
};

export const resolveKiroCliPath = (preferred?: string): string => {
	if (preferred && preferred.length > 0 && existsSync(preferred)) {
		return preferred;
	}
	for (const candidate of kiroCliCandidatePaths()) {
		if (existsSync(candidate)) return candidate;
	}
	return preferred && preferred.length > 0 ? preferred : "kiro-cli";
};

type NodeSqliteModule = typeof import("node:sqlite");

/**
 * Load `node:sqlite` without `createRequire`.
 *
 * Electron packs this package to CJS and mangles locals. A pattern like
 * `const x = createRequire(require("url")...)` can be renamed so the local
 * is literally `require`, which hits the TDZ (`Cannot access 'require'
 * before initialization`). Every open then fails → usage UI says "sign in"
 * despite a valid Kiro token on disk.
 *
 * `process.getBuiltinModule` (Node 22+/Electron) avoids that entirely.
 */
const loadNodeSqlite = (): NodeSqliteModule => {
	const getter = (
		process as NodeJS.Process & {
			getBuiltinModule?: (id: string) => unknown;
		}
	).getBuiltinModule;
	if (typeof getter === "function") {
		return getter("node:sqlite") as NodeSqliteModule;
	}
	// Bun unit tests / older Node — createRequire is fine under ESM.
	return createRequire(import.meta.url)("node:sqlite") as NodeSqliteModule;
};

const openWithDriver = (path: string): SqliteHandle | null => {
	try {
		if (process.versions.bun !== undefined) {
			// Only used under Bun (tests/dev). Electron builds never hit this
			// branch (`process.versions.bun` is unset).
			const bunSqlite = createRequire(import.meta.url)("bun:sqlite") as {
				Database: new (
					filename: string,
					options?: { readonly?: boolean },
				) => SqliteHandle;
			};
			return new bunSqlite.Database(path, { readonly: true });
		}
		const { DatabaseSync } = loadNodeSqlite();
		return new DatabaseSync(path, { readOnly: true });
	} catch (cause) {
		console.warn(
			`[kiro-auth] open sqlite failed for ${path}: ${
				cause instanceof Error ? cause.message : String(cause)
			}`,
		);
		return null;
	}
};

/**
 * Open Kiro's auth DB. The live CLI may hold a write lock; try direct
 * readonly first, then a temp copy of the DB (+ WAL/SHM when present).
 */
const openReadonlyDatabase = (path: string): SqliteHandle | null => {
	if (!existsSync(path)) return null;

	const direct = openWithDriver(path);
	if (direct !== null) return direct;

	// Busy / locked: snapshot the file(s) into a temp dir and read that.
	let tmpDir: string | null = null;
	try {
		tmpDir = mkdtempSync(join(tmpdir(), "zuse-kiro-auth-"));
		const tmpDb = join(tmpDir, "data.sqlite3");
		copyFileSync(path, tmpDb);
		for (const suffix of ["-wal", "-shm"] as const) {
			const side = `${path}${suffix}`;
			if (existsSync(side)) {
				try {
					copyFileSync(side, `${tmpDb}${suffix}`);
				} catch {
					// ignore partial WAL
				}
			}
		}
		const snapped = openWithDriver(tmpDb);
		if (snapped === null) return null;
		const dir = tmpDir;
		tmpDir = null;
		return {
			prepare: (sql: string) => snapped.prepare(sql),
			close: () => {
				try {
					snapped.close();
				} catch {
					// ignore
				}
				try {
					rmSync(dir, { recursive: true, force: true });
				} catch {
					// ignore
				}
			},
		};
	} catch {
		if (tmpDir !== null) {
			try {
				rmSync(tmpDir, { recursive: true, force: true });
			} catch {
				// ignore
			}
		}
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
		if (typeof Buffer !== "undefined" && Buffer.isBuffer(row.value)) {
			return row.value.toString("utf-8");
		}
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
		const expiresRaw =
			typeof parsed.expires_at === "string"
				? parsed.expires_at
				: typeof parsed.expiresAt === "string"
					? parsed.expiresAt
					: null;
		return {
			accessToken,
			refreshToken:
				typeof parsed.refresh_token === "string"
					? parsed.refresh_token
					: typeof parsed.refreshToken === "string"
						? parsed.refreshToken
						: null,
			expiresAt: expiresRaw,
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
	const resolved = resolveKiroCliPath(kiroPath);
	try {
		spawnSync(resolved, ["whoami"], {
			stdio: "ignore",
			timeout: 12_000,
			env: process.env,
			shell: false,
		});
	} catch {
		// ignore — caller will surface no-credentials / expired
	}
};

const readFromSqlite = (): KiroAuthContext | null => {
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

const readFromSsoCache = (): KiroAuthContext | null => {
	// Prefer freshest non-expired cache entry.
	let best: KiroAuthContext | null = null;
	let bestExpiry = Number.NEGATIVE_INFINITY;
	for (const path of ssoCacheTokenPaths()) {
		if (!existsSync(path)) continue;
		try {
			const token = parseToken(readFileSync(path, "utf-8"));
			if (token === null) continue;
			if (tokenExpired(token, 0)) continue;
			const exp =
				token.expiresAt !== null ? Date.parse(token.expiresAt) : Date.now();
			if (Number.isNaN(exp) || exp <= bestExpiry) continue;
			bestExpiry = exp;
			best = {
				token,
				profileArn: null,
				region: token.region,
			};
		} catch {
			// ignore per-file errors
		}
	}
	return best;
};

export const readKiroAuthContext = (
	options: {
		readonly refreshIfExpired?: boolean;
		readonly kiroPath?: string;
	} = {},
): KiroAuthContext | null => {
	const refreshIfExpired = options.refreshIfExpired ?? true;
	const kiroPath = resolveKiroCliPath(options.kiroPath);

	const readOnce = (): KiroAuthContext | null =>
		readFromSqlite() ?? readFromSsoCache();

	let first = readOnce();
	// DB missing / unreadable: still try a CLI refresh so auth_kv is rewritten.
	if (first === null && refreshIfExpired) {
		tryRefreshViaCli(kiroPath);
		first = readOnce();
	}
	if (first === null) return null;
	if (!tokenExpired(first.token) || !refreshIfExpired) return first;

	tryRefreshViaCli(kiroPath);
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
