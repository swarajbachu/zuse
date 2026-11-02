import type { DurableObjectState } from "@cloudflare/workers-types";
import {
	PLUGIN_CALLBACK_PORTS,
	type PluginAttempt,
	type PluginConnection,
	type PluginDefinition,
	type PluginRequest,
	type PluginReturnTo,
	type PluginToolRequest,
} from "@zuse/contracts";
import type {
	EngineAuth,
	EngineConnection,
	EnginePlugin,
	PluginEngine,
	PluginEngineErrorCode,
} from "@zuse/executor-v2";
import {
	decryptAesGcmEnvelope,
	encryptAesGcmEnvelope,
	importAesGcmKey,
} from "./aes-gcm-envelope.ts";
import { findCatalogPlugin, publicPluginCatalog } from "./plugin-catalog.ts";
import {
	assertPluginUrl,
	isAllowedPluginUrl,
	pluginFetch,
	probePluginAuth,
	probePluginKey,
} from "./plugin-egress.ts";
import {
	type PluginErrorCode,
	type PluginIdentity,
	PluginOperationError,
} from "./plugin-host.ts";

export interface PluginVaultEnv {
	readonly PLUGIN_ENCRYPTION_KEY?: string;
	readonly API_PUBLIC_ORIGIN: string;
	readonly PLUGIN_APP_ORIGIN?: string;
}
interface Attempt extends PluginAttempt {
	readonly subject: string;
	readonly tenant: string;
	readonly label: string;
	readonly returnTo?: PluginReturnTo;
	readonly stateToken?: string;
	readonly ticket?: string;

	readonly query?: string;

	readonly code?: string;
	readonly issuer?: string;
}

interface CustomServer {
	readonly id: string;
	readonly name: string;
	readonly endpoint: string;

	readonly header?: string;
	readonly createdAt: number;
}

interface VaultPlugin extends EnginePlugin {
	readonly auth?: EngineAuth;
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,64}$/;
const RESERVED_HEADERS = new Set([
	"accept",
	"connection",
	"content-length",
	"content-type",
	"host",
	"mcp-protocol-version",
	"mcp-session-id",
	"transfer-encoding",
]);
const MAX_SERVERS = 25;
const validKey = (value: string) =>
	value.length > 0 && value.length <= 4096 && !/[\r\n\0]/.test(value);

type StoredRef = Omit<EngineConnection, "plugin" | "auth"> &
	Partial<Pick<EngineConnection, "plugin" | "auth">>;
const ENGINE_ERRORS: Record<PluginEngineErrorCode, PluginErrorCode> = {
	client_registration_unsupported: "plugin_client_registration_unsupported",
	auth_unsupported: "plugin_auth_unsupported",
	unreachable: "plugin_unreachable",
};

let engineModule: typeof import("@zuse/executor-v2") | undefined;
const loadEngineModule = async () => {
	engineModule ??= await import("@zuse/executor-v2");
	return engineModule;
};
const errorCode = (error: unknown): PluginErrorCode =>
	error instanceof PluginOperationError
		? error.code
		: engineModule !== undefined &&
				error instanceof engineModule.PluginEngineError
			? ENGINE_ERRORS[error.code]
			: "plugin_operation_failed";
const TTL = 10 * 60_000;
/** Well inside the 60 s agent client timeout, leaving room for the response. */
const SEARCH_DEADLINE_MS = 20_000;
/** Stop waiting at the deadline; the abandoned discovery settles in the background. */
const withinDeadline = <A>(pending: Promise<A>, signal: AbortSignal) =>
	new Promise<A>((resolve, reject) => {
		const onAbort = () =>
			reject(new PluginOperationError({ code: "plugin_unreachable" }));
		if (signal.aborted) return onAbort();
		signal.addEventListener("abort", onAbort, { once: true });
		pending
			.then(resolve, reject)
			.finally(() => signal.removeEventListener("abort", onAbort));
	});
const encoder = new TextEncoder();
const publicAttempt = (a: PluginAttempt): PluginAttempt => ({
	kind: "attempt",
	id: a.id,
	connectionId: a.connectionId,
	state: a.state,
	authorizationUrl: a.state === "pending" ? a.authorizationUrl : null,
	expiresAt: a.expiresAt,
	error: a.state === "failed" ? (a.error ?? "plugin_operation_failed") : null,
	pluginId: a.pluginId,
});
const isHttpsOrigin = (value: string | undefined) =>
	value !== undefined &&
	URL.canParse(value) &&
	new URL(value).protocol === "https:";

const failureKind = (error: unknown): Record<string, string> => {
	if (typeof error !== "object" || error === null) return { tag: "unknown" };
	const value = error as {
		_tag?: unknown;
		reason?: unknown;
		code?: unknown;
		detail?: { tag?: unknown; reason?: unknown };
		message?: unknown;
	};
	const tag = value.detail?.tag ?? value._tag;
	const reason = value.detail?.reason ?? value.reason;
	return {
		tag: typeof tag === "string" ? tag : "unknown",
		...(typeof reason === "string" ? { reason } : {}),
		...(typeof value.code === "string" ? { code: value.code } : {}),

		...(tag === undefined && typeof value.message === "string"
			? { message: value.message.slice(0, 160) }
			: {}),
	};
};

const rejected = (
	id: string,
	pluginId: string,
	error: PluginErrorCode,
): PluginAttempt => ({
	kind: "attempt",
	id,
	connectionId: id,
	state: "failed",
	authorizationUrl: null,
	expiresAt: Date.now(),
	error,
	pluginId,
});

const publicServer = (server: CustomServer): PluginDefinition => {
	const url = new URL(server.endpoint);
	return {
		id: server.id,
		name: server.name,
		description: url.host,
		domain: url.hostname.replace(/^(?:mcp|api)\./, ""),
		category: null,
		featured: false,
		custom: true,
		url: url.origin + url.pathname,
		apiKeyHeader: server.header ?? null,
	};
};

/** One serialized owner per tenant. SQLite and encrypted KV survive eviction.
 * Upstream mutations are never retried automatically: a timeout may have acted.
 */
export class PluginVault {
	private queue: Promise<unknown> = Promise.resolve();
	private readonly ready: Promise<PluginEngine>;
	/** Loaded before the engine so lazy registration can resolve custom ids. */
	private readonly servers = new Map<string, CustomServer>();
	constructor(
		private readonly ctx: DurableObjectState,
		private readonly env: PluginVaultEnv,
	) {
		this.ready = ctx.blockConcurrencyWhile(async () => {
			const version = await ctx.storage.get("schema-version");
			if (version !== undefined && version !== 2)
				throw new Error("Plugin storage requires an explicit v1 migration");

			if (!env.PLUGIN_ENCRYPTION_KEY || !isHttpsOrigin(env.API_PUBLIC_ORIGIN))
				throw new Error("Plugins are not configured");
			for (const key of (
				await ctx.storage.list({ prefix: "server:" })
			).keys()) {
				const server = await this.read<CustomServer>(key);
				if (server) this.servers.set(server.id, server);
			}
			const { createPluginEngine } = await loadEngineModule();
			const engine = await createPluginEngine({
				storage: ctx.storage,
				encryptionKey: env.PLUGIN_ENCRYPTION_KEY,
				credentialScope: ctx.id.toString(),
				plugin: (id) => this.plugin(id),
				fetch: pluginFetch,
			});
			await ctx.storage.put("schema-version", 2);
			return engine;
		});
	}
	private plugin(id: string): VaultPlugin | undefined {
		const catalog = findCatalogPlugin(id);
		if (catalog) return catalog;
		const server = this.servers.get(id);
		if (!server) return undefined;
		return {
			id: server.id,
			name: server.name,
			endpoint: server.endpoint,
			...(server.header ? { header: server.header, auth: "header" } : {}),
		};
	}
	private owner(identity: PluginIdentity) {
		return JSON.stringify([identity.tenant, identity.subject]);
	}
	private refKey(subject: string, id: string) {
		return `engine:${subject}:${id}`;
	}
	private async ref(
		subject: string,
		id: string,
		pluginId: string,
	): Promise<EngineConnection> {
		const ref = await this.ctx.storage.get<StoredRef>(this.refKey(subject, id));
		if (!ref || (ref.plugin !== undefined && ref.plugin !== pluginId))
			throw new Error("Connection unavailable");

		const auth = ref.auth ?? findCatalogPlugin(pluginId)?.auth;
		if (!auth) throw new Error("Connection unavailable");
		return { ...ref, plugin: pluginId, auth };
	}
	private cryptoKey?: Promise<CryptoKey>;
	private async key() {
		if (!this.env.PLUGIN_ENCRYPTION_KEY)
			throw new Error("Plugins are not configured");
		this.cryptoKey ??= importAesGcmKey(this.env.PLUGIN_ENCRYPTION_KEY);
		return this.cryptoKey;
	}
	private async read<T>(id: string): Promise<T | undefined> {
		const sealed = await this.ctx.storage.get<string>(id);
		if (!sealed) return undefined;
		const bytes = await decryptAesGcmEnvelope({
			key: await this.key(),
			additionalData: encoder.encode(`${this.ctx.id}:${id}`),
			envelope: JSON.parse(sealed),
		});
		return JSON.parse(new TextDecoder().decode(bytes));
	}
	private seal(id: string, value: unknown): Promise<string> {
		return this.key().then((key) =>
			encryptAesGcmEnvelope({
				key,
				additionalData: encoder.encode(`${this.ctx.id}:${id}`),
				plaintext: encoder.encode(JSON.stringify(value)),
			}),
		);
	}
	private async write(id: string, value: unknown) {
		await this.ctx.storage.put(id, await this.seal(id, value));
	}
	private async commit(values: Record<string, unknown>, remove: string[] = []) {
		await this.ctx.storage.transaction(async (storage) => {
			await storage.put(values);
			if (remove.length) await storage.delete(remove);
		});
	}

	fetch(request: Request): Promise<Response> {
		const task = this.queue.then(async () => {
			const executor = await this.ready;
			try {
				const url = new URL(request.url);
				if (url.pathname === "/callback") return await this.callback(url);
				const { identity, command, tool } = (await request.json()) as {
					identity: PluginIdentity;
					command?: PluginRequest;
					tool?: PluginToolRequest;
				};
				const saved = await this.ctx.storage.get<string>("tenant");
				if (saved && saved !== identity.tenant)
					throw new Error("Tenant mismatch");
				if (!saved) await this.ctx.storage.put("tenant", identity.tenant);
				return Response.json(
					tool
						? await this.tools(executor, identity, tool)
						: await this.command(
								executor,
								identity,
								command ??
									(() => {
										throw new Error("Missing command");
									})(),
							),
				);
			} catch (error) {
				return Response.json({ error: errorCode(error) }, { status: 400 });
			}
		});
		this.queue = task.catch(() => undefined);
		return task;
	}
	/** The vault already fences the tenant; only organization-owned rows are shared. */
	private async connections(identity: PluginIdentity) {
		const organization = identity.tenant.startsWith("organization:");
		const rows = await this.ctx.storage.list<PluginConnection>({
			prefix: organization ? "connection:" : `connection:${identity.subject}:`,
		});
		return [...rows].flatMap(([key, row]) => {
			const subject = key.slice("connection:".length, -`:${row.id}`.length);
			return subject === identity.subject ||
				(organization && row.owner === "organization")
				? [{ key, row, subject }]
				: [];
		});
	}
	private async command(
		e: PluginEngine,
		identity: PluginIdentity,
		input: PluginRequest,
	) {
		if (input.action === "list") {
			const rows = await this.connections(identity);
			return {
				kind: "snapshot",
				tenants: [],
				tenantId: identity.tenant,
				endpoint: `${this.env.API_PUBLIC_ORIGIN}/v1/plugins/${encodeURIComponent(identity.tenant)}/mcp`,
				catalog: [
					...[...this.servers.values()]
						.sort((a, b) => a.createdAt - b.createdAt)
						.map(publicServer),
					...publicPluginCatalog(),
				],
				connections: rows.map(({ row }) => row),
			};
		}
		if (
			input.action === "disconnect" ||
			input.action === "setEnabled" ||
			input.action === "rename"
		) {
			const connection = (await this.connections(identity)).find(
				({ row }) => row.id === input.connectionId,
			);
			if (!connection) throw new Error("Connection not found");
			const { key, row, subject } = connection;
			if (input.action === "rename") {
				const label = input.label.trim();
				if (!label || label.length > 80)
					throw new Error("Invalid connection name");
				if (
					(await this.connections(identity)).some(
						({ row: other }) =>
							other.id !== row.id &&
							other.pluginId === row.pluginId &&
							other.label.trim().toLowerCase() === label.toLowerCase(),
					)
				)
					throw new Error("Connection name already exists");
				await this.ctx.storage.put(key, { ...row, label });
				return { kind: "ok" };
			}
			if (input.action === "setEnabled") {
				await this.ctx.storage.put(key, { ...row, enabled: input.enabled });
				return { kind: "ok" };
			}
			await this.removeConnection(e, identity, key, row, subject);
			return { kind: "ok" };
		}
		if (input.action === "removeServer") {
			if (!this.servers.has(input.pluginId)) throw new Error("Unknown server");

			const rows = await this.ctx.storage.list<PluginConnection>({
				prefix: "connection:",
			});
			for (const [key, row] of rows)
				if (row.pluginId === input.pluginId)
					await this.removeConnection(
						e,
						identity,
						key,
						row,
						key.slice("connection:".length, -`:${row.id}`.length),
					);
			await this.ctx.storage.delete(`server:${input.pluginId}`);
			this.servers.delete(input.pluginId);
			return { kind: "ok" };
		}
		if (input.action === "addServer") {
			if (!UUID.test(input.requestId)) throw new Error("Invalid request");
			const hex = input.requestId.replaceAll("-", "");
			const id = `custom-${hex}`;
			const old = await this.read<Attempt>(
				`attempt:${identity.subject}:c${hex}`,
			);
			if (old) return publicAttempt(old);
			const name = input.name.trim();
			const url = input.url.trim();
			const key = input.apiKey;
			if (
				name.length === 0 ||
				name.length > 60 ||
				(key &&
					(!HEADER_NAME.test(key.header) ||
						RESERVED_HEADERS.has(key.header.toLowerCase())))
			)
				throw new Error("Invalid request");
			if (url.length > 2048 || !isAllowedPluginUrl(url))
				return rejected(`c${hex}`, id, "plugin_url_rejected");
			if (key && !validKey(key.value))
				return rejected(`c${hex}`, id, "plugin_credentials_rejected");
			if (this.servers.size >= MAX_SERVERS)
				return rejected(`c${hex}`, id, "plugin_limit_reached");
			const server: CustomServer = {
				id,
				name,
				endpoint: url,
				...(key ? { header: key.header } : {}),
				createdAt: Date.now(),
			};
			await this.write(`server:${id}`, server);
			this.servers.set(id, server);
			const attempt = await this.connect(e, identity, {
				action: "connect",
				tenantId: input.tenantId,
				requestId: input.requestId,
				pluginId: id,
				label: name,
				...(input.returnTo ? { returnTo: input.returnTo } : {}),
				...(key ? { apiKey: key.value } : {}),
			});

			if (attempt.state === "failed") {
				await this.ctx.storage.delete(`server:${id}`);
				this.servers.delete(id);
			}
			return attempt;
		}
		if (input.action === "connect") return this.connect(e, identity, input);
		let a: Attempt | undefined;
		if (input.action === "complete") {
			const pointer = await this.read<{ subject: string; id: string }>(
				`ticket:${input.ticket}`,
			);
			if (!pointer || pointer.subject !== identity.subject)
				throw new Error("Invalid confirmation");
			a = await this.read<Attempt>(`attempt:${identity.subject}:${pointer.id}`);
		} else
			a = await this.read<Attempt>(
				`attempt:${identity.subject}:${input.attemptId}`,
			);
		if (!a || a.tenant !== identity.tenant)
			throw new Error("Attempt not found");
		if (a.state !== "pending") return publicAttempt(a);
		if (a.expiresAt <= Date.now() || input.action === "cancel") {
			return publicAttempt(await this.fail(a, "cancelled"));
		}
		if (input.action === "poll") return publicAttempt(a);
		if (
			!a.stateToken ||
			!(a.query || a.code) ||
			!a.ticket ||
			a.ticket !== input.ticket
		)
			throw new Error("Invalid confirmation");

		await this.ctx.storage.delete(`ticket:${a.ticket}`);
		try {
			const callback = new URL(
				`${this.env.API_PUBLIC_ORIGIN}/v1/plugins/callback/${this.ctx.id}`,
			);
			if (a.query !== undefined) callback.search = a.query;
			else {
				callback.searchParams.set("state", a.stateToken);
				callback.searchParams.set("code", a.code ?? "");
				if (a.issuer !== undefined) callback.searchParams.set("iss", a.issuer);
			}
			const ref = await e.complete(
				this.owner(identity),
				await this.ref(identity.subject, a.id, a.pluginId),
				callback.href,
			);
			await this.ctx.storage.put(this.refKey(identity.subject, a.id), ref);
			await this.finish(a);
			return publicAttempt({ ...a, state: "connected" });
		} catch (error) {
			console.warn(
				JSON.stringify({
					event: "plugin_sign_in_failed",
					plugin: a.pluginId,
					...failureKind(error),
				}),
			);
			return publicAttempt(
				await this.fail(a, "failed", "plugin_sign_in_failed"),
			);
		}
	}
	/** Starts one connection. Failures come back as a failed attempt with a reason. */
	private async connect(
		e: PluginEngine,
		identity: PluginIdentity,
		input: Extract<PluginRequest, { action: "connect" }>,
	): Promise<PluginAttempt> {
		const prefix = `connection:${identity.subject}:`;
		const id = `c${input.requestId.replaceAll("-", "")}`;
		if (!UUID.test(input.requestId) || input.label.length > 80)
			throw new Error("Invalid request");
		const old = await this.read<Attempt>(`attempt:${identity.subject}:${id}`);
		if (old) return publicAttempt(old);
		const plugin = this.plugin(input.pluginId);
		if (!plugin) throw new Error("Unknown plugin");
		if (input.returnTo) this.returnTarget(input.returnTo);
		if (plugin.auth === "header" && !validKey(input.apiKey ?? ""))
			return rejected(id, plugin.id, "plugin_credentials_rejected");
		const a: Attempt = {
			kind: "attempt",
			id,
			connectionId: id,
			state: "pending",
			authorizationUrl: null,
			expiresAt: Date.now() + TTL,
			error: null,
			...identity,
			pluginId: plugin.id,
			label: input.label.trim() || plugin.name,
			...(input.returnTo ? { returnTo: input.returnTo } : {}),
		};
		const existing = await this.ctx.storage.list<PluginConnection>({
			prefix: identity.tenant.startsWith("organization:")
				? "connection:"
				: prefix,
		});
		if ([...existing.values()].some((row) => row.id === id))
			throw new Error("Connection id already exists");
		if (existing.size >= 50)
			return rejected(id, plugin.id, "plugin_limit_reached");
		await this.ctx.storage.setAlarm(Date.now() + TTL);
		await this.write(`attempt:${identity.subject}:${id}`, a);
		await this.ctx.storage.put(prefix + id, {
			id,
			pluginId: plugin.id,
			label: a.label,
			owner: identity.tenant.startsWith("organization:")
				? "organization"
				: "user",
			state: "connecting",
			enabled: true,
			createdAt: Date.now(),
		});
		try {
			const auth = plugin.auth ?? (await probePluginAuth(plugin.endpoint));

			if (auth === "header")
				await probePluginKey(
					plugin.endpoint,
					plugin.header ?? "Authorization",
					input.apiKey ?? "",
				);
			const ref = await e.prepare(
				this.owner(identity),
				identity.subject,
				id,
				plugin.id,
				auth,
			);
			await this.ctx.storage.put(this.refKey(identity.subject, id), ref);
			if (auth === "header") {
				const saved = await e.submit(
					this.owner(identity),
					ref,
					a.label,
					input.apiKey ?? "",
				);
				await this.ctx.storage.put(this.refKey(identity.subject, id), saved);
			}
			if (auth !== "oauth") {
				await this.finish(a);
				return publicAttempt({ ...a, state: "connected" });
			}
			const redirectUri = `${this.env.API_PUBLIC_ORIGIN}/v1/plugins/callback/${this.ctx.id}`;
			const authorizationUrl = await e.start(
				this.owner(identity),
				ref,
				a.label,
				redirectUri,
			);
			assertPluginUrl(authorizationUrl);
			const state = new URL(authorizationUrl).searchParams.get("state");
			if (!state) throw new Error("Missing OAuth state");

			const next = {
				...a,
				authorizationUrl,
				stateToken: state,
			};
			const attemptKey = `attempt:${identity.subject}:${id}`;
			const stateKey = `state:${state}`;
			await this.commit({
				[attemptKey]: await this.seal(attemptKey, next),
				[stateKey]: await this.seal(stateKey, {
					subject: identity.subject,
					id,
				}),
			});
			await this.ctx.storage.setAlarm(Date.now() + TTL);
			return publicAttempt(next);
		} catch (error) {
			console.warn(
				JSON.stringify({
					event: "plugin_connect_failed",
					plugin: plugin.id,
					...failureKind(error),
				}),
			);
			return publicAttempt(await this.fail(a, "failed", errorCode(error)));
		}
	}
	/** Fences invocation before SDK deletion, including partial failures. */
	private async removeConnection(
		e: PluginEngine,
		identity: PluginIdentity,
		key: string,
		row: PluginConnection,
		subject: string,
	) {
		await this.ctx.storage.put(key, { ...row, state: "error" });
		await e.remove(
			this.owner({ ...identity, subject }),
			row.id,
			await this.ctx.storage.get<StoredRef>(this.refKey(subject, row.id)),
		);
		await this.ctx.storage.delete(this.refKey(subject, row.id));
		await this.ctx.storage.delete(key);
	}
	private async finish(a: Attempt) {
		const key = `connection:${a.subject}:${a.connectionId}`;
		const row = await this.ctx.storage.get<PluginConnection>(key);
		if (!row) throw new Error("Connection removed");
		const attemptKey = `attempt:${a.subject}:${a.id}`;
		await this.commit(
			{
				[key]: { ...row, state: "connected" },
				[attemptKey]: await this.seal(attemptKey, {
					...a,
					state: "connected",
					query: undefined,
					code: undefined,
					issuer: undefined,
					ticket: undefined,
					authorizationUrl: null,
				}),
			},
			[
				...(a.stateToken ? [`state:${a.stateToken}`] : []),
				...(a.ticket ? [`ticket:${a.ticket}`] : []),
			],
		);
	}

	private async fail(
		a: Attempt,
		state: "failed" | "cancelled",
		error: PluginErrorCode | null = null,
	) {
		const next = {
			...a,
			state,
			error: state === "failed" ? (error ?? "plugin_operation_failed") : null,
			authorizationUrl: null,
			query: undefined,
			code: undefined,
			issuer: undefined,
			ticket: undefined,
		};
		await this.write(`attempt:${a.subject}:${a.id}`, next);
		const connectionKey = `connection:${a.subject}:${a.connectionId}`;
		const row = await this.ctx.storage.get<PluginConnection>(connectionKey);
		if (row)
			await this.ctx.storage.put(connectionKey, { ...row, state: "error" });
		const ref = await this.ctx.storage.get<StoredRef>(
			this.refKey(a.subject, a.id),
		);
		await (await this.ready).remove(this.owner(a), a.id, ref);
		await this.ctx.storage.delete(this.refKey(a.subject, a.id));
		await this.ctx.storage.delete(connectionKey);

		if (a.stateToken) await this.ctx.storage.delete(`state:${a.stateToken}`);
		if (a.ticket) await this.ctx.storage.delete(`ticket:${a.ticket}`);
		return next;
	}
	private async callback(url: URL): Promise<Response> {
		const state = url.searchParams.get("state");
		if (!state || state.length > 4096) throw new Error("Missing OAuth state");
		const pointer = await this.read<{ subject: string; id: string }>(
			`state:${state}`,
		);
		if (!pointer) throw new Error("Unknown OAuth state");
		const a = await this.read<Attempt>(
			`attempt:${pointer.subject}:${pointer.id}`,
		);
		if (a?.state !== "pending" || a.ticket || a.expiresAt <= Date.now())
			throw new Error("Expired OAuth state");
		if (url.searchParams.has("error")) {
			await this.fail(a, "cancelled");
			return this.redirectBack(a, { plugin_error: "cancelled" });
		}
		const code = url.searchParams.get("code");
		if (!code || code.length > 8192 || url.search.length > 16_384)
			throw new Error("Missing OAuth code");
		const ticket = crypto.randomUUID();
		const attemptKey = `attempt:${a.subject}:${a.id}`;
		const ticketKey = `ticket:${ticket}`;
		await this.commit(
			{
				[attemptKey]: await this.seal(attemptKey, {
					...a,
					query: url.search.slice(1),
					ticket,
				}),
				[ticketKey]: await this.seal(ticketKey, pointer),
			},
			[`state:${state}`],
		);
		return this.redirectBack(a, {
			plugin_ticket: ticket,
			plugin_tenant: a.tenant,
		});
	}
	/** Desktop loopback for registered ports only; otherwise the hosted app. */
	private returnTarget(returnTo: PluginReturnTo | undefined) {
		if (returnTo?.kind === "desktop") {
			if (!PLUGIN_CALLBACK_PORTS.some((port) => port === returnTo.port))
				throw new Error("Invalid plugin callback port");
			return new URL(`http://127.0.0.1:${returnTo.port}/plugins/callback`);
		}
		if (!this.env.PLUGIN_APP_ORIGIN)
			throw new Error("Plugin app origin is missing");
		return new URL(this.env.PLUGIN_APP_ORIGIN);
	}
	private redirectBack(a: Attempt, params: Record<string, string>) {
		const target = this.returnTarget(a.returnTo);
		for (const [key, value] of Object.entries(params))
			target.searchParams.set(key, value);
		target.searchParams.set(
			"plugin",
			this.plugin(a.pluginId)?.name ?? a.pluginId,
		);
		return new Response(null, {
			status: 302,
			headers: {
				location: target.href,
				"cache-control": "no-store",
				"referrer-policy": "no-referrer",
			},
		});
	}
	private async tools(
		e: PluginEngine,
		identity: PluginIdentity,
		input: PluginToolRequest,
	) {
		const connected = (await this.connections(identity)).filter(
			({ row }) =>
				row.state === "connected" &&
				row.enabled !== false &&
				this.plugin(row.pluginId) !== undefined,
		);
		const prefix = (row: PluginConnection) =>
			`tools.${row.pluginId}.user.${row.id}.`;
		if (input.action === "list") {
			return connected.map(({ row: { id, pluginId, label } }) => ({
				connectionId: id,
				pluginId,
				label,
			}));
		}
		if (input.action === "search") {
			const terms = input.query
				.slice(0, 200)
				.toLowerCase()
				.split(/\s+/)
				.filter(Boolean);
			// Discover concurrently under one deadline: a stale or stalled connection
			// must not hide every other plugin's tools or outlast the client timeout.
			const deadline = AbortSignal.timeout(SEARCH_DEADLINE_MS);
			const lists = await Promise.allSettled(
				connected.map(async ({ row, subject }) =>
					withinDeadline(
						e.list(
							this.owner({ ...identity, subject }),
							await this.ref(subject, row.id, row.pluginId),
						),
						deadline,
					),
				),
			);
			const tools = [];
			let failure: unknown;
			for (const [index, { row }] of connected.entries()) {
				const list = lists[index];
				if (!list) continue;
				if (list.status === "rejected") {
					console.warn(
						JSON.stringify({
							event: "plugin_tools_unavailable",
							plugin: row.pluginId,
							...failureKind(list.reason),
						}),
					);
					failure ??= list.reason;
					continue;
				}

				const catalog = this.plugin(row.pluginId);
				const plugin = `${row.pluginId} ${catalog?.name ?? ""} ${row.label}`;
				const serviceNames = plugin.toLowerCase().replace(/[^a-z0-9]/g, "");
				for (const tool of list.value) {
					if (
						terms.every(
							(term) =>
								`${plugin} ${tool.name} ${tool.description}`
									.toLowerCase()
									.includes(term) ||
								(term.replace(/[^a-z0-9]/g, "").length > 0 &&
									serviceNames.includes(term.replace(/[^a-z0-9]/g, ""))),
						)
					)
						tools.push({
							address: prefix(row) + tool.name,
							description: tool.description,
						});
					if (tools.length >= 100) return tools;
				}
			}
			if (
				failure !== undefined &&
				lists.every((list) => list.status === "rejected")
			)
				throw failure;
			return tools;
		}
		const connection = connected.find(({ row }) =>
			input.address.startsWith(prefix(row)),
		);
		if (!connection) throw new Error("Connection unavailable");
		const { row, subject } = connection;
		const owner = this.owner({ ...identity, subject });
		const ref = await this.ref(subject, row.id, row.pluginId);
		const tool = input.address.slice(prefix(row).length);
		try {
			return input.action === "schema"
				? await e.schema(owner, ref, tool)
				: await e.call(owner, ref, tool, input.arguments);
		} catch (error) {
			console.warn(
				JSON.stringify({
					event: "plugin_tool_failed",
					plugin: row.pluginId,
					action: input.action,
					...failureKind(error),
				}),
			);
			throw error;
		}
	}

	alarm(): Promise<void> {
		const task = this.queue.then(() => this.sweep());
		this.queue = task.catch(() => undefined);
		return task;
	}
	private async sweep() {
		const entries = await this.ctx.storage.list<string>({ prefix: "attempt:" });
		for (const key of entries.keys()) {
			const a = await this.read<Attempt>(key);
			if (a && a.expiresAt <= Date.now()) {
				if (a.state === "pending") await this.fail(a, "cancelled");
				if (a.expiresAt + 86400_000 < Date.now())
					await this.ctx.storage.delete(key);
			}
		}
		if (entries.size) await this.ctx.storage.setAlarm(Date.now() + TTL);
	}
}
