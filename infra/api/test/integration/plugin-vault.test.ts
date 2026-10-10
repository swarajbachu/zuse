import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "esbuild";
import { Miniflare } from "miniflare";
import { afterAll, beforeAll, expect, test } from "vitest";
import { PLUGIN_CATALOG } from "../../src/plugin-catalog.ts";

let script: string;
beforeAll(async () => {
	const result = await build({
		entryPoints: [
			new URL("./plugin-vault-worker.ts", import.meta.url).pathname,
		],
		bundle: true,
		write: false,
		format: "esm",
		platform: "node",
		external: ["node:*"],
	});
	const output = result.outputFiles[0];
	if (!output) throw new Error("Worker bundle is missing");
	script = output.text;
});
function firstAddress(value: unknown): string {
	if (!Array.isArray(value) || typeof value[0]?.address !== "string")
		throw new Error("Missing tool address");
	return value[0].address;
}
let calls = 0;
let issuerRequired = true;
let tokenExpiresIn = 3600;
let failTokenExchange = false;
let refreshes = 0;
let registration: Record<string, unknown> | undefined;
/** Catalog entries without an auth hint, so connecting probes them. */
const probed = PLUGIN_CATALOG.filter(
	(p) => !p.auth && /^https:\/\/[^/]+\/mcp$/.test(p.endpoint),
);
const probedPlugin = (index: number) => {
	const plugin = probed[index];
	if (!plugin) throw new Error("Catalog has too few probed entries");
	return {
		id: plugin.id,
		name: plugin.name,
		host: new URL(plugin.endpoint).host,
	};
};
const PROBED = {
	public: probedPlugin(0),
	oauth: probedPlugin(1),
	noRegistration: probedPlugin(2),
	missing: probedPlugin(3),
	down: probedPlugin(4),
};
/** Fixture behavior per upstream host; unlisted hosts are public MCP servers. */
const modes = new Map<string, "oauth" | "no-registration" | "missing" | "down">(
	[
		["mcp.linear.app", "oauth"],
		[PROBED.oauth.host, "oauth"],
		[PROBED.noRegistration.host, "no-registration"],
		[PROBED.missing.host, "missing"],
		[PROBED.down.host, "down"],
	],
);
let probes = 0;
const outboundService = async (request: Request): Promise<Response> => {
	const url = new URL(request.url);
	const mode = modes.get(url.host);
	if (mode === "missing") return new Response(null, { status: 404 });
	if (mode === "down") return new Response(null, { status: 503 });
	if (url.pathname.includes("oauth-protected-resource"))
		return Response.json({
			resource: `${url.origin}/mcp`,
			authorization_servers: [url.origin],
			scopes_supported: ["read", "write"],
		});
	if (
		url.pathname.includes("oauth-authorization-server") ||
		url.pathname.includes("openid-configuration")
	)
		return Response.json({
			issuer: url.origin,
			authorization_response_iss_parameter_supported: issuerRequired,
			authorization_endpoint: `${url.origin}/authorize`,
			token_endpoint: `${url.origin}/token`,
			...(mode === "no-registration"
				? {}
				: { registration_endpoint: `${url.origin}/register` }),
			response_types_supported: ["code"],
			grant_types_supported: ["authorization_code", "refresh_token"],
			code_challenge_methods_supported: ["S256"],
			token_endpoint_auth_methods_supported: ["none"],
			scopes_supported: ["read", "write"],
		});
	if (url.pathname === "/register") {
		registration = await request.json();
		return Response.json(
			{ client_id: "zuse-test", token_endpoint_auth_method: "none" },
			{ status: 201 },
		);
	}
	if (url.pathname === "/token") {
		const form = new URLSearchParams(await request.text());
		if (form.get("grant_type") === "refresh_token") refreshes++;
		if (failTokenExchange)
			return Response.json({ error: "invalid_grant" }, { status: 400 });
		return Response.json({
			access_token: "private-upstream-token",
			refresh_token: "private-refresh-token",
			token_type: "Bearer",
			expires_in: tokenExpiresIn,
			scope: "read write",
		});
	}
	if (
		mode !== undefined &&
		request.headers.get("authorization") !== "Bearer private-upstream-token"
	)
		return new Response(null, {
			status: 401,
			headers: {
				"www-authenticate": `Bearer resource_metadata="${url.origin}/.well-known/oauth-protected-resource"`,
			},
		});
	if (request.method !== "POST") return new Response(null, { status: 405 });
	const m = (await request.json()) as {
		id?: number;
		method: string;
		params?: { arguments?: { text?: string }; clientInfo?: { name?: string } };
	};
	if (
		m.method === "initialize" &&
		m.params?.clientInfo?.name === "zuse-auth-probe"
	)
		probes++;
	if (m.id === undefined) return new Response(null, { status: 202 });
	if (m.method === "tools/call") calls++;
	const result =
		m.method === "initialize"
			? {
					protocolVersion: "2025-03-26",
					capabilities: { tools: {} },
					serverInfo: { name: "fixture", version: "1" },
				}
			: m.method === "tools/list"
				? {
						tools: [
							{
								name: "echo",
								inputSchema: {
									type: "object",
									properties: { text: { type: "string" } },
								},
							},
						],
					}
				: {
						content: [{ type: "text", text: m.params?.arguments?.text ?? "" }],
					};
	return Response.json({ jsonrpc: "2.0", id: m.id, result });
};
const instances = new Set<Miniflare>();
afterAll(async () => {
	await Promise.all([...instances].map((m) => m.dispose()));
});
const create = (persist?: string) => {
	const mf = new Miniflare({
		modules: true,
		script,
		compatibilityDate: "2026-06-01",
		compatibilityFlags: ["nodejs_compat"],
		durableObjects: {
			PLUGIN_VAULT: { className: "PluginVault", useSQLite: true },
		},
		durableObjectsPersist: persist,
		bindings: {
			PLUGIN_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString("base64url"),
			API_PUBLIC_ORIGIN: "https://api.zuse.test",
			PLUGIN_APP_ORIGIN: "https://code.zuse.test",
		},
		outboundService,
	});
	instances.add(mf);
	return mf;
};
async function client(
	mf: Miniflare,
	tenant = "personal:alice",
	subject = "alice",
) {
	const ns = await mf.getDurableObjectNamespace("PLUGIN_VAULT");
	const vault = ns.get(ns.idFromName(tenant));
	return {
		vault,
		request: async (command: unknown, tool?: unknown) => {
			const response = await vault.fetch("https://internal/request", {
				method: "POST",
				body: JSON.stringify({ identity: { tenant, subject }, command, tool }),
			});
			return {
				status: response.status,
				body: (await response.json()) as Record<string, unknown>,
			};
		},
	};
}
test("persists across Worker restarts and isolates subjects and tenants", async () => {
	const directory = await mkdtemp(join(tmpdir(), "zuse-plugin-vault-"));
	try {
		let mf = create(directory);
		let a = await client(mf);
		const command = {
			action: "connect",
			pluginId: "cloudflare",
			label: "Docs",
			requestId: crypto.randomUUID(),
		};
		const connected = await a.request(command);
		expect(connected.status).toBe(200);
		expect(connected.body.state).toBe("connected");
		expect((await a.request(command)).body.id).toBe(connected.body.id);
		const search = await a.request(undefined, { action: "search", query: "" });
		expect(search.body).toHaveLength(1);
		expect((await a.request(undefined, { action: "list" })).body).toEqual([
			{
				connectionId: connected.body.connectionId,
				pluginId: "cloudflare",
				label: "Docs",
			},
		]);
		expect(
			(
				await a.request(undefined, {
					action: "search",
					query: "  Cloudflare   ECHO ",
				})
			).body,
		).toEqual(search.body);
		expect(
			(
				await a.request(undefined, {
					action: "search",
					query: "cloudflare nonexistent",
				})
			).body,
		).toEqual([]);
		// Turning a connection off hides its tools without dropping credentials.
		const connectionId = connected.body.connectionId;
		expect(
			(
				await a.request({
					action: "setEnabled",
					connectionId,
					enabled: false,
				})
			).status,
		).toBe(200);
		expect(
			(await a.request(undefined, { action: "search", query: "" })).body,
		).toEqual([]);
		expect((await a.request(undefined, { action: "list" })).body).toEqual([]);
		await a.request({ action: "setEnabled", connectionId, enabled: true });
		// The plugin id matches every tool, whatever the tool is called.
		expect(
			(await a.request(undefined, { action: "search", query: "cloudflare" }))
				.body,
		).toEqual(search.body);
		const address = firstAddress(search.body);
		expect(
			(await a.request(undefined, { action: "schema", address })).body
				.inputSchema,
		).toBeDefined();
		const before = calls;
		expect(
			(
				await a.request(undefined, {
					action: "call",
					address,
					arguments: { text: "works" },
				})
			).status,
		).toBe(200);
		expect(calls).toBe(before + 1);
		const bob = await client(mf, "personal:alice", "bob");
		expect((await bob.request({ action: "list" })).body.connections).toEqual(
			[],
		);
		expect(
			(await bob.request(undefined, { action: "call", address, arguments: {} }))
				.status,
		).toBe(400);
		const other = await client(mf, "personal:other", "alice");
		expect((await other.request({ action: "list" })).body.connections).toEqual(
			[],
		);
		await mf.dispose();
		instances.delete(mf);
		mf = create(directory);
		a = await client(mf);
		expect((await a.request({ action: "list" })).body.connections).toHaveLength(
			1,
		);
		expect(
			(
				await a.request(undefined, {
					action: "call",
					address,
					arguments: { text: "after restart" },
				})
			).status,
		).toBe(200);
		expect(
			(
				await a.request({
					action: "disconnect",
					connectionId: connected.body.connectionId,
				})
			).status,
		).toBe(200);
		expect(
			(await a.request(undefined, { action: "call", address, arguments: {} }))
				.status,
		).toBe(400);
		await mf.dispose();
		instances.delete(mf);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
}, 60_000);
test("OAuth requires owner confirmation and rejects callback replay", async () => {
	const mf = create();
	const a = await client(mf);
	const started = await a.request({
		action: "connect",
		pluginId: "linear",
		label: "Work",
		requestId: crypto.randomUUID(),
	});
	expect(started.status).toBe(200);
	expect(started.body.state).toBe("pending");
	expect(registration).toMatchObject({ client_name: "Zuse" });
	const authorization = new URL(String(started.body.authorizationUrl));
	expect(authorization.searchParams.get("code_challenge_method")).toBe("S256");
	const state = authorization.searchParams.get("state") ?? "";
	const callbackUrl = new URL(
		authorization.searchParams.get("redirect_uri") ?? "",
	);
	callbackUrl.searchParams.set("state", state);
	callbackUrl.searchParams.set("code", "one-use-code");
	callbackUrl.searchParams.set("iss", "https://mcp.linear.app");
	const callback = await mf.dispatchFetch(callbackUrl.href, {
		redirect: "manual",
	});
	expect(callback.status).toBe(302);
	const ticket = new URL(
		callback.headers.get("location") ?? "",
	).searchParams.get("plugin_ticket");
	expect(
		(await a.request({ action: "poll", attemptId: started.body.id })).body
			.state,
	).toBe("pending");
	const bob = await client(mf, "personal:alice", "bob");
	expect((await bob.request({ action: "complete", ticket })).status).toBe(400);
	const completed = await a.request({ action: "complete", ticket });
	expect(completed.status).toBe(200);
	expect(completed.body.state).toBe("connected");
	expect((await a.request({ action: "complete", ticket })).status).toBe(400);
	expect(
		(
			await a.vault.fetch(
				`https://internal/callback?state=${encodeURIComponent(state)}&code=again`,
			)
		).status,
	).toBe(400);
	const listed = await a.request({ action: "list" });
	expect(JSON.stringify(listed)).not.toContain("private-upstream-token");
	expect(JSON.stringify(listed)).not.toContain("private-refresh-token");
	const search = await a.request(undefined, { action: "search", query: "" });
	expect(search.body).toHaveLength(1);
	expect(
		(
			await a.request(undefined, {
				action: "call",
				address: firstAddress(search.body),
				arguments: { text: "oauth" },
			})
		).status,
	).toBe(200);
	const pending = await a.request({
		action: "connect",
		pluginId: "linear",
		label: "Cancel",
		requestId: crypto.randomUUID(),
	});
	expect(
		(await a.request({ action: "cancel", attemptId: pending.body.id })).body
			.state,
	).toBe("cancelled");
	const stored = await (
		await a.vault.fetch("https://internal/__test/storage")
	).json();
	expect(JSON.stringify(stored)).not.toContain("private-upstream-token");
	expect(JSON.stringify(stored)).not.toContain("private-refresh-token");
	expect(
		(
			await a.request({
				action: "disconnect",
				connectionId: started.body.connectionId,
			})
		).status,
	).toBe(200);
	expect(
		(await a.request(undefined, { action: "search", query: "" })).body,
	).toEqual([]);
	const removed = (await (
		await a.vault.fetch("https://internal/__test/storage")
	).json()) as { rows: Record<string, unknown[]> };
	const accounts = Object.entries(removed.rows).find(([name]) =>
		/accounts$/i.test(name),
	);
	expect(accounts).toBeDefined();
	expect(accounts?.[1]).toEqual([]);
}, 60_000);

async function authorize(
	a: Awaited<ReturnType<typeof client>>,
	issuer: string | null = "https://mcp.linear.app",
	extraQuery = "",
) {
	const started = await a.request({
		action: "connect",
		pluginId: "linear",
		label: "Work",
		requestId: crypto.randomUUID(),
	});
	expect(started.status).toBe(200);
	const state = new URL(String(started.body.authorizationUrl)).searchParams.get(
		"state",
	);
	const callback = await a.vault.fetch(
		`https://internal/callback?state=${encodeURIComponent(state ?? "")}&code=fixture-code${issuer === null ? "" : `&iss=${encodeURIComponent(issuer)}`}${extraQuery}`,
		{ redirect: "manual" },
	);
	expect(callback.status).toBe(302);
	return new URL(callback.headers.get("location") ?? "").searchParams.get(
		"plugin_ticket",
	);
}

test("keeps multiple plugin connections independently addressable", async () => {
	const a = await client(create());
	const connect = () =>
		a.request({
			action: "connect",
			pluginId: "cloudflare",
			label: "Docs",
			requestId: crypto.randomUUID(),
		});
	const [first, second] = await Promise.all([connect(), connect()]);
	expect(first.status).toBe(200);
	expect(second.status).toBe(200);
	expect(
		(await a.request(undefined, { action: "search", query: "" })).body,
	).toHaveLength(2);
	expect(
		(
			await a.request({
				action: "disconnect",
				connectionId: first.body.connectionId,
			})
		).status,
	).toBe(200);
	const remaining = await a.request(undefined, { action: "search", query: "" });
	expect(remaining.body).toHaveLength(1);
	expect(firstAddress(remaining.body)).toContain(second.body.connectionId);
	expect(
		(
			await a.request(undefined, {
				action: "call",
				address: firstAddress(remaining.body),
				arguments: { text: "second" },
			})
		).status,
	).toBe(200);
}, 60_000);

test("refreshes expiring OAuth credentials through v2 before invoking", async () => {
	tokenExpiresIn = 1;
	try {
		const a = await client(create());
		const ticket = await authorize(a);
		expect((await a.request({ action: "complete", ticket })).status).toBe(200);
		tokenExpiresIn = 3600;
		const before = refreshes;
		const tools = await a.request(undefined, { action: "search", query: "" });
		expect(tools.status).toBe(200);
		expect(refreshes).toBeGreaterThan(before);
		expect(
			(
				await a.request(undefined, {
					action: "call",
					address: firstAddress(tools.body),
					arguments: {},
				})
			).status,
		).toBe(200);
	} finally {
		tokenExpiresIn = 3600;
	}
}, 60_000);

test("failed token exchange removes the connection and consumes confirmation", async () => {
	const a = await client(create());
	const ticket = await authorize(a);
	failTokenExchange = true;
	try {
		expect((await a.request({ action: "complete", ticket })).status).toBe(400);
	} finally {
		failTokenExchange = false;
	}
	expect((await a.request({ action: "complete", ticket })).status).toBe(400);
	expect((await a.request({ action: "list" })).body.connections).toEqual([]);
	expect(
		(await a.request(undefined, { action: "search", query: "" })).body,
	).toEqual([]);
}, 60_000);

test("cleans SDK setup when the connection reference was not retained", async () => {
	const a = await client(create());
	const connected = await a.request({
		action: "connect",
		pluginId: "cloudflare",
		label: "Docs",
		requestId: crypto.randomUUID(),
	});
	expect(connected.status).toBe(200);
	await a.vault.fetch(
		`https://internal/__test/forget-reference?id=${connected.body.connectionId}`,
	);
	expect(
		(
			await a.request({
				action: "disconnect",
				connectionId: connected.body.connectionId,
			})
		).status,
	).toBe(200);
	expect((await a.request({ action: "list" })).body.connections).toEqual([]);
	const stored = (await (
		await a.vault.fetch("https://internal/__test/storage")
	).json()) as { rows: Record<string, unknown[]> };
	const apps = Object.entries(stored.rows).find(([name]) =>
		/(?:^|_)apps$/.test(name),
	);
	expect(apps).toBeDefined();
	expect(apps?.[1]).toEqual([]);
}, 60_000);

test("rejects missing and mismatched OAuth issuers instead of bypassing validation", async () => {
	const a = await client(create());
	for (const issuer of [null, "https://wrong-issuer.test"]) {
		const ticket = await authorize(a, issuer);
		expect((await a.request({ action: "complete", ticket })).status).toBe(400);
	}
}, 60_000);

test("passes duplicate OAuth response parameters to Executor for rejection", async () => {
	const a = await client(create());
	for (const extra of [
		"&iss=https%3A%2F%2Fwrong-issuer.test",
		"&code=second-code",
	]) {
		const ticket = await authorize(a, "https://mcp.linear.app", extra);
		expect((await a.request({ action: "complete", ticket })).status).toBe(400);
	}
}, 60_000);

test("supports providers that do not require issuer responses", async () => {
	issuerRequired = false;
	try {
		const a = await client(create());
		const ticket = await authorize(
			a,
			null,
			"&provider_extension=opaque%2Bvalue",
		);
		expect((await a.request({ action: "complete", ticket })).body.state).toBe(
			"connected",
		);
	} finally {
		issuerRequired = true;
	}
}, 60_000);

const legacyBuild = async (definition: object) => {
	const digest = await crypto.subtle.digest(
		"SHA-256",
		new TextEncoder().encode(`export default ${JSON.stringify(definition)};\n`),
	);
	return `bld_${Buffer.from(digest).toString("hex")}`;
};
const storageText = async (a: Awaited<ReturnType<typeof client>>) =>
	JSON.stringify(
		await (await a.vault.fetch("https://internal/__test/storage")).json(),
	);

test("keeps legacy builds and references working after a restart", async () => {
	const directory = await mkdtemp(join(tmpdir(), "zuse-plugin-legacy-"));
	try {
		let mf = create(directory);
		let a = await client(mf);
		const connected = await a.request({
			action: "connect",
			pluginId: "cloudflare",
			label: "Docs",
			requestId: crypto.randomUUID(),
		});
		expect(connected.body.state).toBe("connected");
		// Build IDs from before lazy registration remain valid.
		expect(await storageText(a)).toContain(
			await legacyBuild({
				protocol: 1,
				id: "cloudflare",
				name: "Cloudflare Docs",
				endpoint: "https://docs.mcp.cloudflare.com/mcp",
				auth: "none",
				scopes: [],
			}),
		);
		await a.vault.fetch(
			`https://internal/__test/legacy-reference?id=${connected.body.connectionId}`,
		);
		await mf.dispose();
		instances.delete(mf);
		mf = create(directory);
		a = await client(mf);
		const search = await a.request(undefined, { action: "search", query: "" });
		expect(search.status).toBe(200);
		expect(
			(
				await a.request(undefined, {
					action: "call",
					address: firstAddress(search.body),
					arguments: { text: "legacy" },
				})
			).status,
		).toBe(200);
		await mf.dispose();
		instances.delete(mf);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
}, 60_000);

test("probes unhinted entries and registers them lazily after a restart", async () => {
	const directory = await mkdtemp(join(tmpdir(), "zuse-plugin-probe-"));
	try {
		let mf = create(directory);
		let a = await client(mf);
		const before = probes;
		const hinted = await a.request({
			action: "connect",
			pluginId: "cloudflare",
			label: "Docs",
			requestId: crypto.randomUUID(),
		});
		expect(hinted.body.state).toBe("connected");
		expect(probes).toBe(before);
		const connected = await a.request({
			action: "connect",
			pluginId: PROBED.public.id,
			label: "Public",
			requestId: crypto.randomUUID(),
		});
		expect(connected.body.state).toBe("connected");
		expect(probes).toBe(before + 1);
		const oauth = await a.request({
			action: "connect",
			pluginId: PROBED.oauth.id,
			label: "OAuth",
			requestId: crypto.randomUUID(),
		});
		expect(oauth.body.state).toBe("pending");
		expect(new URL(String(oauth.body.authorizationUrl)).host).toBe(
			PROBED.oauth.host,
		);
		await mf.dispose();
		instances.delete(mf);
		mf = create(directory);
		a = await client(mf);
		const search = await a.request(undefined, { action: "search", query: "" });
		expect(search.body).toHaveLength(2);
		const address = (search.body as unknown as { address: string }[])
			.map((tool) => tool.address)
			.find((address) => address.includes(String(connected.body.connectionId)));
		expect(
			(
				await a.request(undefined, {
					action: "call",
					address,
					arguments: { text: "probed" },
				})
			).status,
		).toBe(200);
		// Auth is persisted with the connection; restarts never re-probe.
		expect(probes).toBe(before + 1);
		await mf.dispose();
		instances.delete(mf);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
}, 60_000);

test("fails unsupported providers cleanly with a readable code", async () => {
	const a = await client(create());
	for (const [plugin, code] of [
		[PROBED.noRegistration, "plugin_client_registration_unsupported"],
		[PROBED.missing, "plugin_auth_unsupported"],
		[PROBED.down, "plugin_unreachable"],
	] as const) {
		const failed = await a.request({
			action: "connect",
			pluginId: plugin.id,
			label: plugin.name,
			requestId: crypto.randomUUID(),
		});
		expect(failed).toEqual({ status: 400, body: { error: code } });
	}
	expect((await a.request({ action: "list" })).body.connections).toEqual([]);
}, 60_000);

const startOAuth = async (
	a: Awaited<ReturnType<typeof client>>,
	returnTo?: unknown,
) => {
	const started = await a.request({
		action: "connect",
		pluginId: "linear",
		label: "Work",
		requestId: crypto.randomUUID(),
		...(returnTo ? { returnTo } : {}),
	});
	expect(started.status).toBe(200);
	const state =
		new URL(String(started.body.authorizationUrl)).searchParams.get("state") ??
		"";
	return { started, state };
};
const callbackLocation = async (
	a: Awaited<ReturnType<typeof client>>,
	query: string,
) => {
	const callback = await a.vault.fetch(`https://internal/callback?${query}`, {
		redirect: "manual",
	});
	expect(callback.status).toBe(302);
	return new URL(callback.headers.get("location") ?? "");
};

test("returns OAuth tickets to the desktop loopback or the hosted app", async () => {
	const mf = create();
	const a = await client(mf);
	const desktop = await startOAuth(a, { kind: "desktop", port: 8977 });
	const location = await callbackLocation(
		a,
		`state=${encodeURIComponent(desktop.state)}&code=fixture-code&iss=${encodeURIComponent("https://mcp.linear.app")}`,
	);
	expect(`${location.origin}${location.pathname}`).toBe(
		"http://127.0.0.1:8977/plugins/callback",
	);
	expect(location.searchParams.get("plugin")).toBe("Linear");
	expect(location.searchParams.get("plugin_tenant")).toBe("personal:alice");
	const ticket = location.searchParams.get("plugin_ticket");
	// Completing without a click stays bound to the subject that started it.
	const bob = await client(mf, "personal:alice", "bob");
	expect((await bob.request({ action: "complete", ticket })).status).toBe(400);
	expect((await a.request({ action: "complete", ticket })).body.state).toBe(
		"connected",
	);
	for (const returnTo of [undefined, { kind: "web" }]) {
		const web = await startOAuth(a, returnTo);
		const hosted = await callbackLocation(
			a,
			`state=${encodeURIComponent(web.state)}&code=fixture-code&iss=${encodeURIComponent("https://mcp.linear.app")}`,
		);
		expect(hosted.origin).toBe("https://code.zuse.test");
		expect(hosted.searchParams.get("plugin")).toBe("Linear");
		expect(hosted.searchParams.get("plugin_ticket")).toBeTruthy();
	}
}, 60_000);

test("rejects unregistered desktop ports and redirects provider errors", async () => {
	const a = await client(create());
	const rejected = await a.request({
		action: "connect",
		pluginId: "linear",
		label: "Work",
		requestId: crypto.randomUUID(),
		returnTo: { kind: "desktop", port: 8080 },
	});
	expect(rejected.status).toBe(400);
	expect((await a.request({ action: "list" })).body.connections).toEqual([]);
	const { started, state } = await startOAuth(a, {
		kind: "desktop",
		port: 8976,
	});
	const location = await callbackLocation(
		a,
		`state=${encodeURIComponent(state)}&error=access_denied`,
	);
	expect(`${location.origin}${location.pathname}`).toBe(
		"http://127.0.0.1:8976/plugins/callback",
	);
	expect(location.searchParams.get("plugin_error")).toBe("cancelled");
	expect(location.searchParams.get("plugin")).toBe("Linear");
	expect(location.searchParams.has("plugin_ticket")).toBe(false);
	expect(
		(await a.request({ action: "poll", attemptId: started.body.id })).body
			.state,
	).toBe("cancelled");
	expect((await a.request({ action: "list" })).body.connections).toEqual([]);
}, 60_000);

test("organization connections are shared with organization machines and members, never Personal or another organization", async () => {
	const mf = create(undefined);
	const admin = await client(mf, "organization:team", "alice");
	const member = await client(mf, "organization:team", "bob");
	const machine = await client(mf, "organization:team", "organization:team");
	const personal = await client(mf);
	const other = await client(mf, "organization:other", "alice");
	const requestId = crypto.randomUUID();
	const connected = await admin.request({
		action: "connect",
		pluginId: "cloudflare",
		label: "Team docs",
		requestId,
	});
	expect(connected.status).toBe(200);
	const duplicate = await member.request({
		action: "connect",
		pluginId: "cloudflare",
		label: "Other",
		requestId,
	});
	expect(duplicate.status).toBe(400);
	const snapshot = await member.request({ action: "list" });
	expect(snapshot.body.connections).toMatchObject([
		{ owner: "organization", label: "Team docs" },
	]);
	const search = await machine.request(undefined, {
		action: "search",
		query: "Cloudflare",
	});
	// Discovery matches the catalog service name even when the account label differs.
	const byName = await machine.request(undefined, {
		action: "search",
		query: "cloudflaredocs",
	});
	expect(byName.body).toEqual(search.body);
	const address = firstAddress(search.body);
	expect(
		(await machine.request(undefined, { action: "schema", address })).status,
	).toBe(200);
	expect(
		(
			await machine.request(undefined, {
				action: "call",
				address,
				arguments: { text: "organization" },
			})
		).status,
	).toBe(200);
	for (const outsider of [personal, other]) {
		expect(
			(await outsider.request(undefined, { action: "list" })).body,
		).toEqual([]);
		expect(
			(
				await outsider.request(undefined, {
					action: "call",
					address,
					arguments: {},
				})
			).status,
		).toBe(400);
	}
	await member.request({
		action: "setEnabled",
		connectionId: connected.body.connectionId,
		enabled: false,
	});
	expect((await machine.request(undefined, { action: "list" })).body).toEqual(
		[],
	);
	await member.request({
		action: "disconnect",
		connectionId: connected.body.connectionId,
	});
	expect((await admin.request({ action: "list" })).body.connections).toEqual(
		[],
	);
});
