import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { promisify } from "node:util";
import { Context, Effect } from "effect";
import { GitHubSharedReads } from "./github-shared-read.ts";

export type GitHubFailureKind =
	| "authentication"
	| "access"
	| "offline"
	| "timeout"
	| "rate_limited"
	| "unknown";

export class GitHubFailure extends Error {
	readonly _tag = "GitHubFailure";
	constructor(
		readonly kind: GitHubFailureKind,
		message: string,
		readonly retryAt?: number,
		readonly status?: number,
	) {
		super(message);
	}
}

export interface GitHubCredential {
	readonly host: string;
	readonly token: string;
	readonly fingerprint: string;
	readonly expiresAt: number;
}

export type GitHubScope = {
	readonly key: string;
	readonly body: string;
	readonly env?: Readonly<Record<string, string>>;
	readonly resolveEnv?: () => Promise<Readonly<Record<string, string>>>;
};
export const GitHubRequestScope = Context.Reference<GitHubScope | null>(
	"zuse/git/GitHubRequestScope",
	{ defaultValue: () => null },
);

export const githubExecutionEnvironment = Effect.flatMap(
	GitHubRequestScope,
	(scope) => {
		const resolve = scope?.resolveEnv;
		return resolve
			? Effect.tryPromise({
					try: resolve,
					catch: () =>
						new GitHubFailure(
							"authentication",
							"Cloud GitHub actor context is unavailable. Reconnect this workspace.",
						),
				})
			: Effect.succeed(scope?.env);
	},
);

export type GitHubCredentialResolver = (
	host: string,
	cwd: string,
	signal: AbortSignal,
	scope?: GitHubScope,
) => Promise<{ token: string; expiresAt?: number }>;

export interface GitHubRepository {
	readonly host: string;
	readonly owner: string;
	readonly repo: string;
	readonly cwd: string;
	readonly credentialScope?: GitHubScope;
}

type Budget = {
	remaining: number;
	limit: number;
	resetAt: number;
	reserved: number;
	pauseUntil: number;
	failures: number;
	estimatedCost: number;
};

export type GitHubResponse = {
	status: number;
	headers: Headers;
	body: string;
};

export const credentialFingerprint = (host: string, token: string): string =>
	createHash("sha256").update(`${host}\0${token}`).digest("hex");

/** API roots are derived from the trusted repository host, never response links. */
export function githubApiRoot(host: string): string {
	if (!/^[a-zA-Z0-9.-]+(?::\d+)?$/.test(host))
		throw new GitHubFailure("unknown", "Invalid GitHub host.");
	return host === "github.com"
		? "https://api.github.com"
		: host.endsWith(".ghe.com")
			? `https://api.${host}`
			: `https://${host}/api/v3`;
}

const execute = promisify(execFile);
export const desktopGitHubCredential: GitHubCredentialResolver = async (
	host,
	cwd,
	signal,
) => {
	const publicHost = host === "github.com" || host.endsWith(".ghe.com");
	const token = publicHost
		? process.env.GH_TOKEN || process.env.GITHUB_TOKEN
		: process.env.GH_ENTERPRISE_TOKEN || process.env.GITHUB_ENTERPRISE_TOKEN;
	if (token) return { token };
	try {
		const result = await execute("gh", ["auth", "token", "--hostname", host], {
			cwd,
			signal,
			timeout: 10_000,
			maxBuffer: 16_384,
		});
		if (result.stdout.trim()) return { token: result.stdout.trim() };
	} catch {
		if (signal.aborted) throw signal.reason;
	}
	throw new GitHubFailure(
		"authentication",
		`GitHub authentication required for ${host}. Sign in with gh auth login or configure a GitHub token.`,
	);
};

/** Server-local transport. Tokens never cross an RPC or appear in diagnostics. */
export class GitHubClient {
	private readonly credentials = new Map<
		string,
		GitHubCredential & { refreshAt: number }
	>();
	private readonly credentialReads = new GitHubSharedReads();
	private readonly budgets = new Map<string, Budget>();
	private readonly controllers = new Set<AbortController>();
	private readonly waiters: Array<() => void> = [];
	private active = 0;
	private closed = false;
	private readonly validators = new Map<
		string,
		{ etag: string; response: GitHubResponse }
	>();
	readonly metrics = { rest: 0, graphql: 0, graphqlCost: 0, notModified: 0 };

	constructor(
		private readonly options: {
			resolveCredential?: GitHubCredentialResolver;
			fetch?: typeof fetch;
			now?: () => number;
		} = {},
	) {}

	get now(): number {
		return (this.options.now ?? Date.now)();
	}

	async credential(
		repository: GitHubRepository,
		signal: AbortSignal,
	): Promise<GitHubCredential> {
		const key = `${repository.host}\0${repository.credentialScope?.key ?? ""}\0${process.env.ZUSE_GITHUB_CONTEXT_DIR ?? ""}\0${credentialFingerprint(repository.host, [process.env.GH_TOKEN, process.env.GITHUB_TOKEN, process.env.GH_ENTERPRISE_TOKEN, process.env.GITHUB_ENTERPRISE_TOKEN].join("\0"))}`;
		const cached = this.credentials.get(key);
		if (
			cached &&
			cached.refreshAt > this.now &&
			cached.expiresAt > this.now + 5_000
		)
			return cached;
		return this.credentialReads.run(key, signal, async (readSignal) => {
			const controller = new AbortController();
			this.controllers.add(controller);
			const credentialSignal = AbortSignal.any([
				readSignal,
				controller.signal,
				AbortSignal.timeout(20_000),
			]);
			try {
				const result = await (
					this.options.resolveCredential ?? desktopGitHubCredential
				)(
					repository.host,
					repository.cwd,
					credentialSignal,
					repository.credentialScope,
				);
				readSignal.throwIfAborted();
				if (!result.token.trim())
					throw new GitHubFailure(
						"authentication",
						"GitHub credential is empty.",
					);
				const value = {
					host: repository.host,
					token: result.token,
					fingerprint: credentialFingerprint(repository.host, result.token),
					expiresAt: result.expiresAt ?? Infinity,
					refreshAt: this.now + 5 * 60_000,
				};
				if (value.expiresAt <= this.now)
					throw new GitHubFailure(
						"authentication",
						"GitHub credential has expired.",
					);
				if (this.credentials.size >= 512)
					this.credentials.delete(this.credentials.keys().next().value ?? "");
				this.credentials.set(key, value);
				return value;
			} catch (cause) {
				if (readSignal.aborted || controller.signal.aborted) throw cause;
				const error =
					cause instanceof GitHubFailure
						? cause
						: new GitHubFailure(
								credentialSignal.aborted ? "timeout" : "offline",
								credentialSignal.aborted
									? "GitHub credential renewal timed out."
									: "GitHub credentials could not be renewed.",
							);
				if (
					!readSignal.aborted &&
					cached &&
					cached.expiresAt > this.now + 5_000 &&
					error instanceof GitHubFailure &&
					(error.kind === "offline" || error.kind === "timeout")
				) {
					cached.refreshAt = this.now + 30_000;
					return cached;
				}
				throw error;
			} finally {
				this.controllers.delete(controller);
			}
		});
	}

	invalidate(credential?: GitHubCredential): void {
		for (const [key, value] of this.credentials)
			if (!credential || value.fingerprint === credential.fingerprint)
				this.credentials.delete(key);
	}

	private budget(
		credential: GitHubCredential,
		api: "rest" | "graphql",
	): Budget {
		const key = `${credential.fingerprint}\0${api}`;
		let value = this.budgets.get(key);
		if (!value) {
			if (this.budgets.size >= 1024)
				this.budgets.delete(this.budgets.keys().next().value ?? "");
			value = {
				remaining: Infinity,
				limit: 0,
				resetAt: 0,
				reserved: 0,
				pauseUntil: 0,
				failures: 0,
				estimatedCost: 1,
			};
			this.budgets.set(key, value);
		}
		if (value.resetAt && this.now >= value.resetAt) {
			value.remaining = Infinity;
			value.resetAt = 0;
		}
		return value;
	}

	private async acquire(signal: AbortSignal): Promise<() => void> {
		while (this.active >= 8) {
			await new Promise<void>((resolve, reject) => {
				const wake = () => {
					signal.removeEventListener("abort", abort);
					resolve();
				};
				const abort = () => {
					const index = this.waiters.indexOf(wake);
					if (index >= 0) this.waiters.splice(index, 1);
					reject(signal.reason);
				};
				this.waiters.push(wake);
				signal.addEventListener("abort", abort, { once: true });
				if (signal.aborted) abort();
			});
		}
		signal.throwIfAborted();
		this.active++;
		return () => {
			this.active--;
			this.waiters.shift()?.();
		};
	}

	async request(input: {
		credential: GitHubCredential;
		api: "rest" | "graphql";
		path: string;
		method?: string;
		body?: unknown;
		etag?: string;
		accept?: string;
		interactive?: boolean;
		estimatedCost?: number;
		signal: AbortSignal;
		maxBytes?: number;
	}): Promise<GitHubResponse> {
		if (this.closed)
			throw new GitHubFailure("offline", "GitHub client stopped.");
		const controller = new AbortController();
		this.controllers.add(controller);
		const signal = AbortSignal.any([
			input.signal,
			controller.signal,
			AbortSignal.timeout(30_000),
		]);
		let release: (() => void) | undefined;
		let reserved = false;
		const budget = this.budget(input.credential, input.api);
		const estimate = input.estimatedCost ?? budget.estimatedCost;
		try {
			release = await this.acquire(signal);
			const reserve =
				input.api === "graphql" && !input.interactive
					? Math.ceil(budget.limit * 0.1)
					: 0;
			if (
				budget.pauseUntil > this.now ||
				budget.remaining - budget.reserved - estimate < reserve
			)
				throw new GitHubFailure(
					"rate_limited",
					"GitHub refresh paused until the API budget recovers.",
					Math.max(budget.pauseUntil, budget.resetAt),
				);
			budget.reserved += estimate;
			if (Number.isFinite(budget.remaining)) budget.remaining -= estimate;
			reserved = true;
			const root = githubApiRoot(input.credential.host);
			const url =
				input.api === "graphql"
					? `${root.replace(/\/v3$/, "")}/graphql`
					: `${root}/${input.path.replace(/^\//, "")}`;
			if (input.path.includes("://") || input.path.split("/").includes(".."))
				throw new GitHubFailure("unknown", "Invalid GitHub API path.");
			this.metrics[input.api]++;
			let response = await (this.options.fetch ?? fetch)(url, {
				method: input.method ?? "GET",
				signal,
				redirect: "manual",
				headers: {
					authorization: `Bearer ${input.credential.token}`,
					accept: input.accept ?? "application/vnd.github+json",
					"content-type": "application/json",
					"x-github-api-version": "2022-11-28",
					...(input.etag ? { "if-none-match": input.etag } : {}),
				},
				...(input.body === undefined
					? {}
					: { body: JSON.stringify(input.body) }),
			});
			const quotaHeaders = response.headers;
			// Actions log URLs are signed storage links. Never forward the GitHub token.
			if (input.path.endsWith("/logs") && response.status === 302) {
				const location = response.headers.get("location");
				if (!location || new URL(location).protocol !== "https:")
					throw new GitHubFailure(
						"unknown",
						"GitHub returned an invalid log URL.",
					);
				await response.body?.cancel();
				response = await (this.options.fetch ?? fetch)(location, {
					signal,
					redirect: "error",
				});
			}
			const resetAt = Number(quotaHeaders.get("x-ratelimit-reset")) * 1000;
			const remaining = quotaHeaders.get("x-ratelimit-remaining");
			if (remaining !== null && Number.isFinite(Number(remaining))) {
				const newWindow =
					resetAt > budget.resetAt && this.now >= budget.resetAt;
				budget.remaining = newWindow
					? Number(remaining)
					: Math.min(budget.remaining, Number(remaining));
				budget.limit =
					Number(quotaHeaders.get("x-ratelimit-limit")) || budget.limit;
				budget.resetAt = Math.max(budget.resetAt, resetAt);
			}
			let body = "";
			const reader = response.body?.getReader();
			if (reader) {
				const chunks: Uint8Array[] = [];
				let size = 0;
				try {
					for (;;) {
						const chunk = await reader.read();
						if (chunk.done) break;
						size += chunk.value.byteLength;
						if (size > (input.maxBytes ?? 8 * 1024 * 1024))
							throw new GitHubFailure(
								"unknown",
								"GitHub response exceeded the size limit.",
							);
						chunks.push(chunk.value);
					}
					body = Buffer.concat(chunks).toString("utf8");
				} finally {
					await reader.cancel().catch(() => undefined);
				}
			}
			let payload: {
				message?: string;
				errors?: Array<{ message?: string; type?: string }>;
				data?: {
					rateLimit?: {
						cost: number;
						remaining: number;
						limit: number;
						resetAt: string;
					};
				};
			} = {};
			try {
				const decoded = JSON.parse(body);
				if (decoded && typeof decoded === "object") payload = decoded;
			} catch {
				/* Non-JSON logs/diffs and 304 are expected. */
			}
			const rate = payload.data?.rateLimit;
			if (rate) {
				budget.remaining = Math.min(budget.remaining, rate.remaining);
				budget.limit = rate.limit;
				budget.resetAt = Math.max(budget.resetAt, Date.parse(rate.resetAt));
				this.metrics.graphqlCost += rate.cost;
				budget.estimatedCost = Math.max(budget.estimatedCost, rate.cost);
			}
			const messages = [
				payload.message,
				...(payload.errors ?? []).map((e) => e.message),
			]
				.filter(Boolean)
				.join("; ");
			const limited =
				response.status === 429 ||
				((response.status === 403 || (payload.errors?.length ?? 0) > 0) &&
					(remaining === "0" ||
						/rate.?limit|abuse|secondary limit/i.test(messages) ||
						payload.errors?.some((e) => e.type === "RATE_LIMITED")));
			if (limited) {
				const primary = remaining === "0" || rate?.remaining === 0;
				const retry = response.headers.get("retry-after");
				const retryAt = retry
					? Number.isFinite(Number(retry))
						? this.now + Number(retry) * 1000
						: Date.parse(retry)
					: 0;
				const pause = Math.max(
					retryAt || 0,
					primary ? budget.resetAt : 0,
					this.now + Math.min(900_000, 30_000 * 2 ** budget.failures++),
				);
				budget.pauseUntil = pause;
				if (primary && !budget.resetAt) budget.resetAt = pause;
				// A secondary limit protects both APIs; primary quota buckets remain independent.
				if (!primary)
					this.budget(
						input.credential,
						input.api === "rest" ? "graphql" : "rest",
					).pauseUntil = pause;
				throw new GitHubFailure(
					"rate_limited",
					"GitHub API rate limit exceeded.",
					pause,
					response.status,
				);
			}
			if (
				response.status === 401 ||
				payload.errors?.some(
					(error) =>
						error.type === "UNAUTHORIZED" ||
						error.type === "UNAUTHENTICATED" ||
						/bad credentials/i.test(error.message ?? ""),
				)
			) {
				this.invalidate(input.credential);
				throw new GitHubFailure(
					"authentication",
					"GitHub authentication has expired. Reconnect GitHub.",
					undefined,
					401,
				);
			}
			if (response.status === 403 || response.status === 404)
				throw new GitHubFailure(
					"access",
					"GitHub repository or resource is unavailable to this account.",
					undefined,
					response.status,
				);
			if (
				payload.errors?.some(
					(error) => error.type === "FORBIDDEN" || error.type === "NOT_FOUND",
				)
			)
				throw new GitHubFailure(
					"access",
					"GitHub resource is unavailable to this account.",
					undefined,
					response.status,
				);
			if ((!response.ok && response.status !== 304) || payload.errors?.length)
				throw new GitHubFailure(
					"unknown",
					messages || `GitHub returned HTTP ${response.status}.`,
					undefined,
					response.status,
				);
			if (response.status === 304) this.metrics.notModified++;
			budget.failures = 0;
			return { status: response.status, headers: response.headers, body };
		} catch (error) {
			if (error instanceof GitHubFailure) throw error;
			if (input.signal.aborted || controller.signal.aborted) throw error;
			throw new GitHubFailure(
				signal.aborted ? "timeout" : "offline",
				signal.aborted
					? "GitHub request timed out."
					: "Could not reach GitHub.",
			);
		} finally {
			if (reserved) budget.reserved -= estimate;
			release?.();
			this.controllers.delete(controller);
		}
	}

	async graphql<T>(
		credential: GitHubCredential,
		query: string,
		variables: Record<string, unknown>,
		signal: AbortSignal,
		interactive = true,
	): Promise<T> {
		// All query documents in this package use an outer selection ending at the final brace.
		const document = query.trimStart().startsWith("mutation")
			? query
			: query.replace(/}\s*$/, " rateLimit { cost limit remaining resetAt } }");
		const response = await this.request({
			credential,
			api: "graphql",
			path: "graphql",
			method: "POST",
			body: { query: document, variables },
			signal,
			interactive,
		});
		try {
			const value = JSON.parse(response.body);
			if (!value?.data || typeof value.data !== "object")
				throw new GitHubFailure(
					"unknown",
					"GitHub returned incomplete GraphQL data.",
				);
			return value.data as T;
		} catch {
			throw new GitHubFailure("unknown", "GitHub returned invalid JSON.");
		}
	}

	async rest<T>(
		credential: GitHubCredential,
		path: string,
		signal: AbortSignal,
		options: { method?: string; body?: unknown; interactive?: boolean } = {},
	): Promise<T> {
		const response =
			options.method && options.method !== "GET"
				? await this.request({
						credential,
						api: "rest",
						path,
						signal,
						...options,
					})
				: await this.conditional(
						credential,
						path,
						signal,
						options.interactive ?? true,
					);
		if (!response.body) return undefined as T;
		try {
			return JSON.parse(response.body) as T;
		} catch {
			throw new GitHubFailure("unknown", "GitHub returned invalid JSON.");
		}
	}

	async pages<T>(
		credential: GitHubCredential,
		path: string,
		signal: AbortSignal,
		select: (value: unknown) => T[] = (value) => value as T[],
	): Promise<T[]> {
		const result: T[] = [];
		for (let page = 1; page <= 100; page++) {
			const response = await this.conditional(
				credential,
				`${path}${path.includes("?") ? "&" : "?"}per_page=100&page=${page}`,
				signal,
			);
			let entries: T[];
			try {
				entries = select(JSON.parse(response.body));
			} catch {
				throw new GitHubFailure(
					"unknown",
					"GitHub pagination returned invalid data.",
				);
			}
			if (!Array.isArray(entries))
				throw new GitHubFailure(
					"unknown",
					"GitHub pagination returned invalid data.",
				);
			result.push(...entries);
			if (!/rel="next"/.test(response.headers.get("link") ?? "")) return result;
		}
		throw new GitHubFailure(
			"unknown",
			"GitHub pagination is incomplete. Refresh to retry.",
		);
	}

	async conditional(
		credential: GitHubCredential,
		path: string,
		signal: AbortSignal,
		interactive = true,
	): Promise<GitHubResponse> {
		const key = `${credential.fingerprint}\0${path}`;
		const cached = this.validators.get(key);
		const response = await this.request({
			credential,
			api: "rest",
			path,
			etag: cached?.etag,
			signal,
			interactive,
		});
		if (response.status === 304) {
			if (!cached)
				throw new GitHubFailure(
					"unknown",
					"GitHub returned a validator without a cached response.",
				);
			return cached.response;
		}
		const etag = response.headers.get("etag");
		if (etag && response.body.length <= 256 * 1024) {
			this.validators.delete(key);
			if (this.validators.size >= 128)
				this.validators.delete(this.validators.keys().next().value ?? "");
			this.validators.set(key, { etag, response });
		}
		return response;
	}

	close(): void {
		this.closed = true;
		for (const controller of this.controllers) controller.abort();
		this.credentials.clear();
		this.credentialReads.close();
		this.budgets.clear();
		this.validators.clear();
	}
}

/** Default keeps isolated package consumers self-contained; server composition provides one instance. */
export const GitHubClientService = Context.Reference<GitHubClient | null>(
	"zuse/git/GitHubClient",
	{ defaultValue: () => null },
);
