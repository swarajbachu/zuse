import { randomBytes } from "node:crypto";
import { readFile, realpath, stat } from "node:fs/promises";
import { extname, relative, resolve, sep } from "node:path";

export const BROWSER_SECURITY_HEADERS = {
	"content-security-policy": [
		"default-src 'self'",
		"script-src 'self'",
		"style-src 'self' 'unsafe-inline'",
		"img-src 'self' data: blob:",
		"font-src 'self' data:",
		"connect-src 'self' ws: wss:",
		"worker-src 'self' blob:",
		"object-src 'none'",
		"base-uri 'self'",
		"frame-ancestors 'none'",
		"form-action 'self'",
	].join("; "),
	"referrer-policy": "no-referrer",
	"x-content-type-options": "nosniff",
	"x-frame-options": "DENY",
} as const;

const MIME_TYPES: Readonly<Record<string, string>> = {
	".avif": "image/avif",
	".css": "text/css; charset=utf-8",
	".gif": "image/gif",
	".html": "text/html; charset=utf-8",
	".ico": "image/x-icon",
	".jpeg": "image/jpeg",
	".jpg": "image/jpeg",
	".js": "text/javascript; charset=utf-8",
	".json": "application/json; charset=utf-8",
	".map": "application/json; charset=utf-8",
	".mjs": "text/javascript; charset=utf-8",
	".png": "image/png",
	".svg": "image/svg+xml",
	".wasm": "application/wasm",
	".webp": "image/webp",
	".woff": "font/woff",
	".woff2": "font/woff2",
};

export type StaticAsset = {
	readonly body: Uint8Array;
	readonly contentType: string;
	readonly cacheControl: string;
};

const safePath = (root: string, pathname: string): string | null => {
	if (pathname.includes("\0")) return null;
	let decoded: string;
	try {
		decoded = decodeURIComponent(pathname);
	} catch {
		return null;
	}
	if (decoded.includes("\0")) return null;
	const candidate = resolve(
		root,
		`.${decoded.startsWith("/") ? decoded : `/${decoded}`}`,
	);
	const fromRoot = relative(root, candidate);
	if (
		fromRoot === ".." ||
		fromRoot.startsWith(`..${sep}`) ||
		resolve(candidate) === resolve(root)
	) {
		return null;
	}
	return candidate;
};

const readRegularFile = async (
	root: string,
	path: string,
): Promise<Uint8Array | null | "invalid"> => {
	try {
		const [realRoot, realFile] = await Promise.all([
			realpath(root),
			realpath(path),
		]);
		const fromRoot = relative(realRoot, realFile);
		if (fromRoot === ".." || fromRoot.startsWith(`..${sep}`)) return "invalid";
		const metadata = await stat(realFile);
		if (!metadata.isFile()) return null;
		return await readFile(realFile);
	} catch {
		return null;
	}
};

/** Resolve a browser asset without ever allowing the request path outside root. */
export const readStaticAsset = async (
	root: string,
	pathname: string,
): Promise<StaticAsset | "invalid" | null> => {
	const candidate = safePath(root, pathname === "/" ? "/index.html" : pathname);
	if (candidate === null) return "invalid";
	let selectedPath = candidate;
	let body = await readRegularFile(root, selectedPath);
	if (body === "invalid") return "invalid";
	if (body === null) {
		if (pathname.startsWith("/assets/") || extname(pathname) !== "")
			return null;
		selectedPath = resolve(root, "index.html");
		body = await readRegularFile(root, selectedPath);
	}
	if (body === "invalid") return "invalid";
	if (body === null) return null;
	const extension = extname(selectedPath).toLowerCase();
	const isIndex = selectedPath === resolve(root, "index.html");
	const isHashedAsset =
		pathname.startsWith("/assets/") &&
		/(?:^|[-_.])[a-f0-9]{8,}(?:[-_.]|$)/iu.test(pathname);
	return {
		body,
		contentType: MIME_TYPES[extension] ?? "application/octet-stream",
		cacheControl: isIndex
			? "no-cache"
			: isHashedAsset
				? "public, max-age=31536000, immutable"
				: "no-cache",
	};
};

export const browserCookieName = (environmentId: string): string =>
	`zuse_session_${environmentId.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 48)}`;

export const browserSessionCookie = (
	name: string,
	token: string,
	secure: boolean,
): string =>
	`${name}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Strict${secure ? "; Secure" : ""}`;

export const clearedBrowserSessionCookie = (
	name: string,
	secure: boolean,
): string =>
	`${name}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secure ? "; Secure" : ""}`;

export type BrowserRequestSecurity = {
	readonly tls: boolean;
	readonly trustProxy: boolean;
};

const firstHeaderValue = (value: string | undefined): string | undefined =>
	value?.split(",")[0]?.trim();

export const isSecureRequest = (
	headers: Readonly<Record<string, string>>,
	security: BrowserRequestSecurity = { tls: false, trustProxy: false },
): boolean =>
	security.tls ||
	(security.trustProxy &&
		firstHeaderValue(headers["x-forwarded-proto"]) === "https");

export const hasValidRequestOrigin = (
	headers: Readonly<Record<string, string>>,
	security: BrowserRequestSecurity = { tls: false, trustProxy: false },
): boolean => {
	const origin = headers.origin;
	if (origin === undefined) return false;
	const expectedHost =
		(security.trustProxy
			? firstHeaderValue(headers["x-forwarded-host"])
			: undefined) ?? headers.host;
	if (!expectedHost) return false;
	try {
		const parsed = new URL(origin);
		const expectedProtocol = isSecureRequest(headers, security)
			? "https:"
			: "http:";
		return parsed.host === expectedHost && parsed.protocol === expectedProtocol;
	} catch {
		return false;
	}
};

const isLoopbackHost = (host: string): boolean => {
	const normalized = host.trim().toLowerCase();
	if (normalized === "localhost" || normalized.endsWith(".localhost"))
		return true;
	try {
		const hostname = new URL(`http://${normalized}`).hostname;
		return (
			hostname === "localhost" ||
			hostname.endsWith(".localhost") ||
			hostname === "127.0.0.1" ||
			hostname.startsWith("127.") ||
			hostname === "[::1]" ||
			hostname === "::1"
		);
	} catch {
		return false;
	}
};

export const requestRequiresAuthentication = (
	policy: "local" | "protected",
	headers: Readonly<Record<string, string>>,
	trustProxy = false,
): boolean => {
	if (policy === "protected") return true;
	const host =
		(trustProxy ? firstHeaderValue(headers["x-forwarded-host"]) : undefined) ??
		headers.host;
	return host !== undefined && !isLoopbackHost(host);
};

type TicketEntry = { readonly credential: string; readonly expiresAt: number };

/** In-memory, short-lived, single-use credentials for browser WebSocket upgrades. */
export class WebSocketTicketStore {
	readonly #tickets = new Map<string, TicketEntry>();

	constructor(
		readonly ttlMs = 30_000,
		readonly now: () => number = Date.now,
	) {}

	issue(credential: string): {
		readonly ticket: string;
		readonly expiresAt: Date;
	} {
		this.prune();
		const ticket = `zws_${randomBytes(24).toString("base64url")}`;
		const expiresAt = this.now() + this.ttlMs;
		this.#tickets.set(ticket, { credential, expiresAt });
		return { ticket, expiresAt: new Date(expiresAt) };
	}

	consume(ticket: string): string | null {
		const entry = this.#tickets.get(ticket);
		this.#tickets.delete(ticket);
		if (entry === undefined || entry.expiresAt <= this.now()) return null;
		return entry.credential;
	}

	private prune(): void {
		const now = this.now();
		for (const [ticket, entry] of this.#tickets) {
			if (entry.expiresAt <= now) this.#tickets.delete(ticket);
		}
	}
}

export class PairingRateLimiter {
	readonly #attempts = new Map<string, ReadonlyArray<number>>();
	#globalAttempts: ReadonlyArray<number> = [];

	constructor(
		readonly limit = 8,
		readonly windowMs = 60_000,
		readonly now: () => number = Date.now,
		readonly maxKeys = 2_048,
		readonly globalLimit = Math.max(limit * 16, 64),
	) {}

	allow(key: string): boolean {
		const currentTime = this.now();
		const cutoff = currentTime - this.windowMs;
		this.#globalAttempts = this.#globalAttempts.filter(
			(attempt) => attempt > cutoff,
		);
		if (this.#globalAttempts.length >= this.globalLimit) return false;
		for (const [candidate, candidateAttempts] of this.#attempts) {
			if (candidateAttempts.every((attempt) => attempt <= cutoff)) {
				this.#attempts.delete(candidate);
			}
		}
		if (!this.#attempts.has(key) && this.#attempts.size >= this.maxKeys) {
			const oldest = this.#attempts.keys().next().value;
			if (oldest !== undefined) this.#attempts.delete(oldest);
		}
		const attempts = (this.#attempts.get(key) ?? []).filter(
			(attempt) => attempt > cutoff,
		);
		if (attempts.length >= this.limit) {
			this.#attempts.set(key, attempts);
			return false;
		}
		this.#attempts.set(key, [...attempts, currentTime]);
		this.#globalAttempts = [...this.#globalAttempts, currentTime];
		return true;
	}
}
