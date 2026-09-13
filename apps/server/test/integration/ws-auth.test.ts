import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { createServer, Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NodeSocket } from "@effect/platform-node";
import { AttachmentService } from "@zuse/agents/kernel/attachment-service";
import { makeRpcClientSession } from "@zuse/client-runtime/connection";
import { wsClientProtocolLayer } from "@zuse/client-runtime/ws-protocol";
import { PingResult, PingRpc, WIRE_PROTOCOL_VERSION } from "@zuse/contracts";
import { layer as sqliteLayer } from "@zuse/sqlite";
import { Effect, Layer, ManagedRuntime, Schema } from "effect";
import { Rpc, RpcGroup, RpcServer } from "effect/unstable/rpc";
import { describe, expect, it, vi } from "vitest";

import { LanAuthServiceLive } from "../../src/lan-auth/layers/lan-auth-service.ts";
import type { LanAuthPolicy } from "../../src/lan-auth/policy.ts";
import {
	LanAuthConfig,
	LanAuthService,
} from "../../src/lan-auth/services/lan-auth-service.ts";
import { Migration0021AuthTokens } from "../../src/persistence/migrations/0021_auth_tokens.ts";
import { Migration0024RemoteConnectState } from "../../src/persistence/migrations/0024_remote_connect_state.ts";
import { Migration0025RelayEnvironmentKeys } from "../../src/persistence/migrations/0025_relay_environment_keys.ts";
import { Migration0028RelayMintPublicKey } from "../../src/persistence/migrations/0028_relay_mint_public_key.ts";
import { Migration0039AuthTokenDevices } from "../../src/persistence/migrations/0039_auth_token_devices.ts";
import { Migration0040BlockedNearbyDevices } from "../../src/persistence/migrations/0040_blocked_nearby_devices.ts";
import { Migration0052ApiConfig } from "../../src/persistence/migrations/0052_api_config.ts";
import { wsServerProtocolLayer } from "../../src/transports/ws.ts";

const LargePayloadRpc = Rpc.make("test.largePayload", {
	payload: Schema.Struct({}),
	success: Schema.String,
});
const TestRpcs = RpcGroup.make(PingRpc, LargePayloadRpc);
const LARGE_PAYLOAD = "large-session-payload\n".repeat(256 * 1024);

const PingHandler = TestRpcs.toLayerHandler("ping.ping", () =>
	Effect.succeed(PingResult.make({ message: "pong", receivedAt: new Date() })),
);
const LargePayloadHandler = TestRpcs.toLayerHandler("test.largePayload", () =>
	Effect.succeed(LARGE_PAYLOAD),
);

const freePort = async (): Promise<number> =>
	await new Promise((resolve, reject) => {
		const server = createServer();
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			const address = server.address();
			if (address === null || typeof address === "string") {
				server.close(() => reject(new Error("no tcp port")));
				return;
			}
			const port = address.port;
			server.close(() => resolve(port));
		});
	});

const makeRuntime = (opts: {
	readonly policy: LanAuthPolicy;
	readonly port: number;
	readonly pairingBootstrap?: boolean;
	readonly compression?: boolean;
	readonly maxPayloadBytes?: number;
	readonly staticDir?: string;
	readonly trustProxy?: boolean;
	readonly attachment?: {
		readonly id: string;
		readonly bytes: Uint8Array;
		readonly mimeType: string;
	};
	readonly onListening?: (address: {
		readonly host: string;
		readonly port: number;
	}) => void;
	readonly onDiagnostic?: (
		event: string,
		fields?: Record<string, unknown>,
	) => void;
	readonly onAuthenticatedConnection?: () => () => void;
}) => {
	const SqlLive = sqliteLayer({ filename: ":memory:" });
	const Migrated = Layer.effectDiscard(
		Migration0021AuthTokens.pipe(
			Effect.andThen(Migration0024RemoteConnectState),
			Effect.andThen(Migration0025RelayEnvironmentKeys),
			Effect.andThen(Migration0028RelayMintPublicKey),
			Effect.andThen(Migration0039AuthTokenDevices),
			Effect.andThen(Migration0040BlockedNearbyDevices),
			Effect.andThen(Migration0052ApiConfig),
		),
	).pipe(Layer.provideMerge(SqlLive));
	const ConfigLive = Layer.succeed(LanAuthConfig, {
		policy: opts.policy,
		advertisedHost: "127.0.0.1",
		port: opts.port,
		pairingBootstrap: opts.pairingBootstrap ?? false,
	});
	const LanAuthLayer = LanAuthServiceLive.pipe(
		Layer.provideMerge(Migrated),
		Layer.provide(ConfigLive),
	);
	const AttachmentLayer = Layer.succeed(AttachmentService, {
		upload: () => Effect.die("unused"),
		saveText: () => Effect.die("unused"),
		read: (id: string) =>
			Effect.succeed(
				id === opts.attachment?.id
					? {
							bytes: opts.attachment.bytes,
							mimeType: opts.attachment.mimeType,
						}
					: null,
			),
		readForSession: (_sessionId, id) =>
			Effect.succeed(
				id === opts.attachment?.id
					? {
							bytes: opts.attachment.bytes,
							mimeType: opts.attachment.mimeType,
							originalName: "fixture.png",
							sizeBytes: opts.attachment.bytes.byteLength,
						}
					: null,
			),
		readPath: () => Effect.succeed(null),
	});
	const ProtocolLayer = wsServerProtocolLayer({
		port: opts.port,
		host: "127.0.0.1",
		onListening: opts.onListening,
		staticDir: opts.staticDir,
		trustProxy: opts.trustProxy,
		compression: opts.compression,
		maxPayloadBytes: opts.maxPayloadBytes,
		onDiagnostic: opts.onDiagnostic,
		onAuthenticatedConnection: opts.onAuthenticatedConnection,
	}).pipe(Layer.provide(Layer.merge(LanAuthLayer, AttachmentLayer)));
	const ServerLayer = RpcServer.layer(TestRpcs).pipe(
		Layer.provide(Layer.merge(PingHandler, LargePayloadHandler)),
		Layer.provide(ProtocolLayer),
	);
	return ManagedRuntime.make(Layer.mergeAll(LanAuthLayer, ServerLayer));
};

const disposeRuntime = async (
	runtime: Pick<ManagedRuntime.ManagedRuntime<never, never>, "dispose">,
) => {
	await Promise.race([
		runtime.dispose(),
		new Promise<void>((resolve) => setTimeout(resolve, 500)),
	]);
};

const upgradeResponse = (
	port: number,
	path: string,
	headers: Readonly<Record<string, string>> = {},
): Promise<{
	readonly status: number;
	readonly headers: Readonly<Record<string, string>>;
}> =>
	new Promise((resolve, reject) => {
		const socket = new Socket();
		const timeout = setTimeout(() => {
			socket.destroy();
			reject(new Error("upgrade timeout"));
		}, 2_000);
		let data = "";
		socket.once("error", (error) => {
			clearTimeout(timeout);
			reject(error);
		});
		socket.on("data", (chunk) => {
			data += chunk.toString("utf8");
			if (!data.includes("\r\n\r\n")) return;
			clearTimeout(timeout);
			socket.destroy();
			const [head = ""] = data.split("\r\n\r\n");
			const lines = head.split("\r\n");
			const status = Number(lines[0]?.split(" ")[1]);
			const responseHeaders = Object.fromEntries(
				lines.slice(1).flatMap((line) => {
					const separator = line.indexOf(":");
					return separator === -1
						? []
						: [
								[
									line.slice(0, separator).toLowerCase(),
									line.slice(separator + 1).trim(),
								],
							];
				}),
			);
			resolve({ status, headers: responseHeaders });
		});
		socket.connect(port, "127.0.0.1", () => {
			const requestHeaders = [
				`GET ${path} HTTP/1.1`,
				`Host: 127.0.0.1:${port}`,
				"Connection: Upgrade",
				"Upgrade: websocket",
				"Sec-WebSocket-Version: 13",
				`Sec-WebSocket-Key: ${randomBytes(16).toString("base64")}`,
				...Object.entries(headers).map(([key, value]) => `${key}: ${value}`),
				"",
				"",
			].join("\r\n");
			socket.write(requestHeaders);
		});
	});

const upgradeStatus = (
	port: number,
	path: string,
	headers: Readonly<Record<string, string>> = {},
): Promise<number> =>
	upgradeResponse(port, path, headers).then((response) => response.status);

describe("WS LAN auth", () => {
	it("serves favicon images through the authenticated asset route", async () => {
		const port = await freePort();
		const runtime = makeRuntime({ policy: "protected", port });
		const originalFetch = globalThis.fetch;
		const imageBytes = new Uint8Array([137, 80, 78, 71]);
		const upstream = vi
			.spyOn(globalThis, "fetch")
			.mockImplementation((input, init) => {
				if (String(input).startsWith("https://www.google.com/s2/favicons?")) {
					return Promise.resolve(
						new Response(imageBytes, {
							headers: { "content-type": "image/png" },
						}),
					);
				}
				return originalFetch(input, init);
			});
		try {
			const pairing = await runtime.runPromise(
				Effect.gen(function* () {
					const auth = yield* LanAuthService;
					return yield* auth.createPairingCode();
				}),
			);
			const origin = `http://127.0.0.1:${port}`;
			const url = `${origin}/assets/site-favicon/github.com`;
			expect((await originalFetch(url)).status).toBe(401);
			expect(upstream).not.toHaveBeenCalled();
			const paired = await originalFetch(`${origin}/auth/browser-session`, {
				method: "POST",
				headers: { "content-type": "application/json", origin },
				body: JSON.stringify({ credential: pairing.code }),
			});
			expect(paired.status).toBe(200);
			const cookie = paired.headers.get("set-cookie")?.split(";")[0] ?? "";
			const response = await originalFetch(url, { headers: { cookie } });
			expect(response.status).toBe(200);
			expect(response.headers.get("content-type")).toBe("image/png");
			expect(response.headers.get("cache-control")).toContain("max-age=86400");
			expect(new Uint8Array(await response.arrayBuffer())).toEqual(imageBytes);
			for (const [hostname, status] of [
				["%", 404],
				["github.com%2Fsecret", 400],
			] as const) {
				expect(
					(
						await originalFetch(`${origin}/assets/site-favicon/${hostname}`, {
							headers: { cookie },
						})
					).status,
				).toBe(status);
			}
			expect(upstream).toHaveBeenCalledTimes(1);
		} finally {
			upstream.mockRestore();
			await disposeRuntime(runtime);
		}
	});

	it("negotiates bounded per-message compression when clients offer it", async () => {
		const port = await freePort();
		const runtime = makeRuntime({ policy: "local", port });
		try {
			await runtime.runPromise(Effect.void);
			const response = await upgradeResponse(
				port,
				`/?wireVersion=${WIRE_PROTOCOL_VERSION}`,
				{ "Sec-WebSocket-Extensions": "permessage-deflate" },
			);
			expect(response.status).toBe(101);
			expect(response.headers["sec-websocket-extensions"]).toContain(
				"permessage-deflate",
			);
			expect(response.headers["sec-websocket-extensions"]).toContain(
				"server_no_context_takeover",
			);
			expect(response.headers["sec-websocket-extensions"]).toContain(
				"client_no_context_takeover",
			);
		} finally {
			await disposeRuntime(runtime);
		}
	});

	it("can disable WebSocket compression for compatibility", async () => {
		const port = await freePort();
		const runtime = makeRuntime({ policy: "local", port, compression: false });
		try {
			await runtime.runPromise(Effect.void);
			const response = await upgradeResponse(
				port,
				`/?wireVersion=${WIRE_PROTOCOL_VERSION}`,
				{ "Sec-WebSocket-Extensions": "permessage-deflate" },
			);
			expect(response.status).toBe(101);
			expect(response.headers["sec-websocket-extensions"]).toBeUndefined();
		} finally {
			await disposeRuntime(runtime);
		}
	});

	it("enforces the inbound payload limit when compression is disabled", async () => {
		const port = await freePort();
		const runtime = makeRuntime({
			policy: "local",
			port,
			compression: false,
			maxPayloadBytes: 1_024,
		});
		try {
			await runtime.runPromise(Effect.void);
			const socket = new WebSocket(
				`ws://127.0.0.1:${port}/?wireVersion=${WIRE_PROTOCOL_VERSION}`,
			);
			await new Promise<void>((resolve, reject) => {
				socket.addEventListener("open", () => resolve(), { once: true });
				socket.addEventListener(
					"error",
					() => reject(new Error("open failed")),
					{
						once: true,
					},
				);
			});
			const closeCode = new Promise<number>((resolve) => {
				socket.addEventListener("close", (event) => resolve(event.code), {
					once: true,
				});
			});
			socket.send("x".repeat(2_048));
			expect(await closeCode).toBe(1_009);
		} finally {
			await disposeRuntime(runtime);
		}
	});

	it("serves the browser SPA with secure cache policy and traversal protection", async () => {
		const port = await freePort();
		const staticDir = await mkdtemp(join(tmpdir(), "zuse-client-"));
		await mkdir(join(staticDir, "assets"));
		await writeFile(join(staticDir, "index.html"), "<main>Zuse</main>");
		await writeFile(join(staticDir, "assets", "app-deadbeef.js"), "ok");
		await writeFile(join(staticDir, "assets", "runtime.js"), "ok");
		const runtime = makeRuntime({ policy: "local", port, staticDir });
		try {
			await runtime.runPromise(Effect.void);
			const asset = await fetch(
				`http://127.0.0.1:${port}/assets/app-deadbeef.js`,
			);
			expect(asset.status).toBe(200);
			expect(asset.headers.get("cache-control")).toContain("immutable");
			expect(asset.headers.get("x-content-type-options")).toBe("nosniff");
			const unhashed = await fetch(
				`http://127.0.0.1:${port}/assets/runtime.js`,
			);
			expect(unhashed.headers.get("cache-control")).toBe("no-cache");
			const root = await fetch(`http://127.0.0.1:${port}/`);
			expect(root.status).toBe(200);
			expect(await root.text()).toContain("Zuse");
			const missingAsset = await fetch(
				`http://127.0.0.1:${port}/assets/missing-deadbeef.js`,
			);
			expect(missingAsset.status).toBe(404);

			const fallback = await fetch(`http://127.0.0.1:${port}/projects/example`);
			expect(fallback.status).toBe(200);
			expect(fallback.headers.get("cache-control")).toBe("no-cache");
			expect(await fallback.text()).toContain("Zuse");

			const traversal = await fetch(`http://127.0.0.1:${port}/%2e%2e%2fsecret`);
			expect(traversal.status).toBe(400);
		} finally {
			await disposeRuntime(runtime);
		}
	});

	it("pairs browser cookies and exchanges them for single-use WebSocket tickets", async () => {
		const port = await freePort();
		const origin = `http://127.0.0.1:${port}`;
		const runtime = makeRuntime({
			policy: "protected",
			port,
			pairingBootstrap: true,
			trustProxy: true,
			attachment: {
				id: "attachment_1",
				bytes: new TextEncoder().encode("browser attachment"),
				mimeType: "text/plain",
			},
		});
		try {
			const pairing = await runtime.runPromise(
				Effect.gen(function* () {
					const auth = yield* LanAuthService;
					return yield* auth.createPairingCode();
				}),
			);
			const before = await fetch(`${origin}/auth/session`);
			await expect(before.json()).resolves.toMatchObject({
				authenticated: false,
				authRequired: true,
			});

			const rejectedOrigin = await fetch(`${origin}/auth/browser-session`, {
				method: "POST",
				headers: {
					"content-type": "application/json",
					origin: "https://attacker.invalid",
				},
				body: JSON.stringify({ credential: pairing.code }),
			});
			expect(rejectedOrigin.status).toBe(403);

			const missingOrigin = await fetch(`${origin}/auth/browser-session`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ credential: pairing.code }),
			});
			expect(missingOrigin.status).toBe(403);

			const paired = await fetch(`${origin}/auth/browser-session`, {
				method: "POST",
				headers: {
					"content-type": "application/json",
					origin: "https://serve.example.test",
					"x-forwarded-host": "serve.example.test",
					"x-forwarded-proto": "https",
				},
				body: JSON.stringify({ credential: pairing.code }),
			});
			expect(paired.status).toBe(200);
			const setCookie = paired.headers.get("set-cookie");
			expect(setCookie).toContain("HttpOnly");
			expect(setCookie).toContain("SameSite=Strict");
			expect(setCookie).toContain("Secure");
			const cookie = setCookie?.split(";")[0] ?? "";

			const session = await fetch(`${origin}/auth/session`, {
				headers: { cookie },
			});
			await expect(session.json()).resolves.toMatchObject({
				authenticated: true,
			});

			const attachment = await fetch(
				`${origin}/assets/attachments/attachment_1`,
				{ headers: { cookie } },
			);
			expect(attachment.status).toBe(200);
			expect(attachment.headers.get("cache-control")).toContain("private");
			expect(await attachment.text()).toBe("browser attachment");

			const ticketResponse = await fetch(`${origin}/auth/websocket-ticket`, {
				method: "POST",
				headers: { cookie, origin },
			});
			expect(ticketResponse.status).toBe(200);
			const { ticket } = (await ticketResponse.json()) as {
				readonly ticket: string;
			};
			const rpcPath = `/rpc?ticket=${encodeURIComponent(ticket)}&wireVersion=${WIRE_PROTOCOL_VERSION}`;
			await expect(upgradeStatus(port, rpcPath)).resolves.toBe(101);
			await expect(upgradeStatus(port, rpcPath)).resolves.toBe(401);

			const logout = await fetch(`${origin}/auth/logout`, {
				method: "POST",
				headers: { cookie, origin },
			});
			expect(logout.status).toBe(200);
			expect(logout.headers.get("set-cookie")).toContain("Max-Age=0");

			const [browserToken] = await runtime.runPromise(
				Effect.gen(function* () {
					const auth = yield* LanAuthService;
					const tokens = yield* auth.listTokens();
					return tokens.filter((token) => token.label === "Browser");
				}),
			);
			expect(browserToken).toBeDefined();
			if (browserToken !== undefined) {
				await runtime.runPromise(
					Effect.gen(function* () {
						const auth = yield* LanAuthService;
						yield* auth.revokeToken(browserToken.id);
					}),
				);
			}
			const revokedSession = await fetch(`${origin}/auth/session`, {
				headers: { cookie },
			});
			await expect(revokedSession.json()).resolves.toMatchObject({
				authenticated: false,
			});
		} finally {
			await disposeRuntime(runtime);
		}
	});

	it("reports the actual address assigned to a port-zero server", async () => {
		let listening: { readonly host: string; readonly port: number } | undefined;
		const runtime = makeRuntime({
			policy: "local",
			port: 0,
			onListening: (address) => {
				listening = address;
			},
		});
		try {
			await runtime.runPromise(Effect.void);
			expect(listening).toEqual({
				host: "127.0.0.1",
				port: expect.any(Number),
			});
			expect(listening?.port).toBeGreaterThan(0);
			await expect(
				upgradeStatus(
					listening?.port ?? 0,
					`/?wireVersion=${WIRE_PROTOCOL_VERSION}`,
				),
			).resolves.toBe(101);
		} finally {
			await disposeRuntime(runtime);
		}
	});

	it("round-trips a multi-megabyte compressed outbound RPC response", async () => {
		const port = await freePort();
		const runtime = makeRuntime({
			policy: "local",
			port,
		});
		try {
			await runtime.runPromise(Effect.void);
			const clientSession = await makeRpcClientSession(
				wsClientProtocolLayer(
					{
						host: "127.0.0.1",
						port,
					},
					{
						// Keep this transport test on Effect's Node WebSocket implementation.
						// Node's built-in Undici client currently aborts this valid compressed frame.
						makeWebSocket: (url, protocols) =>
							new NodeSocket.NodeWS.WebSocket(
								url,
								protocols,
							) as unknown as WebSocket,
					},
				),
				TestRpcs,
			);
			try {
				const received = await Effect.runPromise(
					clientSession.client["test.largePayload"]({}),
				);
				expect(received).toBe(LARGE_PAYLOAD);
			} finally {
				await clientSession.dispose();
			}
		} finally {
			await disposeRuntime(runtime);
		}
	});

	it("rejects unauthenticated protected requests before upgrade", async () => {
		const port = await freePort();
		const connected = vi.fn(() => vi.fn());
		const runtime = makeRuntime({
			policy: "protected",
			port,
			pairingBootstrap: true,
			onAuthenticatedConnection: connected,
		});
		try {
			await runtime.runPromise(Effect.void);
			const response = await fetch(`http://127.0.0.1:${port}/`);
			expect(response.status).toBe(401);
			await expect(upgradeStatus(port, "/")).resolves.toBe(401);
			expect(connected).not.toHaveBeenCalled();
		} finally {
			await disposeRuntime(runtime);
		}
	});

	it("redeems pairing codes and accepts query-token WebSockets", async () => {
		const port = await freePort();
		const diagnostics: Array<{
			readonly event: string;
			readonly fields: Record<string, unknown>;
		}> = [];
		const releases: Array<ReturnType<typeof vi.fn>> = [];
		const connected = vi.fn(() => {
			const release = vi.fn();
			releases.push(release);
			return release;
		});
		const runtime = makeRuntime({
			policy: "protected",
			port,
			pairingBootstrap: true,
			onDiagnostic: (event, fields = {}) => {
				diagnostics.push({ event, fields });
			},
			onAuthenticatedConnection: connected,
		});
		try {
			const pairing = await runtime.runPromise(
				Effect.gen(function* () {
					const auth = yield* LanAuthService;
					return yield* auth.createPairingCode();
				}),
			);

			const bad = await fetch(`http://127.0.0.1:${port}/pair`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ code: "zp_bad" }),
			});
			expect(bad.status).toBe(401);

			const response = await fetch(`http://127.0.0.1:${port}/pair`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					code: pairing.code,
					deviceId: "mobile_phone_1",
					deviceLabel: "iPhone",
				}),
			});
			expect(response.status).toBe(200);
			const body = (await response.json()) as {
				readonly token: string;
				readonly environmentId: string;
			};
			expect(body.token.startsWith("zt_")).toBe(true);
			expect(body.environmentId.startsWith("env_")).toBe(true);
			const summaries = await runtime.runPromise(
				Effect.gen(function* () {
					const auth = yield* LanAuthService;
					return yield* auth.listTokens();
				}),
			);
			expect(summaries).toMatchObject([
				{ deviceId: "mobile_phone_1", label: "iPhone" },
			]);

			const second = await fetch(`http://127.0.0.1:${port}/pair`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ code: pairing.code }),
			});
			expect(second.status).toBe(401);

			await expect(
				upgradeStatus(
					port,
					`/?token=${encodeURIComponent(body.token)}&wireVersion=${WIRE_PROTOCOL_VERSION}`,
				),
			).resolves.toBe(101);
			await expect(
				upgradeStatus(
					port,
					`/rpc?token=${encodeURIComponent(body.token)}&wireVersion=${WIRE_PROTOCOL_VERSION}`,
				),
			).resolves.toBe(101);
			await vi.waitFor(() => {
				expect(connected).toHaveBeenCalledTimes(2);
				expect(releases).toHaveLength(2);
				expect(
					releases.every((release) => release.mock.calls.length === 1),
				).toBe(true);
			});
			const authDiagnostics = diagnostics.filter(
				(entry) =>
					entry.event === "ws.request" || entry.event.startsWith("ws.auth."),
			);
			expect(authDiagnostics.length).toBeGreaterThan(0);
			expect(JSON.stringify(authDiagnostics)).not.toContain(body.token);
			expect(authDiagnostics).toEqual(
				expect.arrayContaining([
					expect.objectContaining({
						fields: expect.objectContaining({
							path: expect.stringMatching(/^\/(?:rpc)?$/),
							hasToken: true,
						}),
					}),
				]),
			);
		} finally {
			await disposeRuntime(runtime);
		}
	});

	it("accepts Authorization header bearer tokens where the client supports headers", async () => {
		const port = await freePort();
		const runtime = makeRuntime({
			policy: "protected",
			port,
			pairingBootstrap: true,
		});
		try {
			const token = await runtime.runPromise(
				Effect.gen(function* () {
					const auth = yield* LanAuthService;
					const minted = yield* auth.mintToken("header client");
					return minted.token;
				}),
			);

			await expect(
				upgradeStatus(port, `/?wireVersion=${WIRE_PROTOCOL_VERSION}`, {
					Authorization: `Bearer ${token}`,
				}),
			).resolves.toBe(101);
		} finally {
			await disposeRuntime(runtime);
		}
	});

	it("diagnoses CLI protocol and credential compatibility over HTTP", async () => {
		const port = await freePort();
		const runtime = makeRuntime({ policy: "protected", port });
		try {
			const token = await runtime.runPromise(
				Effect.gen(function* () {
					const auth = yield* LanAuthService;
					return (yield* auth.mintToken("CLI diagnostics")).token;
				}),
			);
			const endpoint = `http://127.0.0.1:${port}/auth/cli-session`;

			const missing = await fetch(endpoint);
			expect(missing.status).toBe(401);
			await expect(missing.json()).resolves.toMatchObject({
				error: "unauthorized",
				protocolVersion: WIRE_PROTOCOL_VERSION,
			});

			const stale = await fetch(endpoint, {
				headers: { authorization: "Bearer stale-token" },
			});
			expect(stale.status).toBe(401);

			const authenticated = await fetch(endpoint, {
				headers: { authorization: `Bearer ${token}` },
			});
			expect(authenticated.status).toBe(200);
			await expect(authenticated.json()).resolves.toEqual({
				authenticated: true,
				protocolVersion: WIRE_PROTOCOL_VERSION,
			});
		} finally {
			await disposeRuntime(runtime);
		}
	});

	it("preserves unauthenticated local loopback connections", async () => {
		const port = await freePort();
		const runtime = makeRuntime({ policy: "local", port });
		try {
			await runtime.runPromise(Effect.void);
			const localSession = await fetch(`http://127.0.0.1:${port}/auth/session`);
			await expect(localSession.json()).resolves.toMatchObject({
				authenticated: true,
				authRequired: false,
			});
			const forwardedSession = await fetch(
				`http://127.0.0.1:${port}/auth/session`,
				{ headers: { "x-forwarded-host": "serve.example.test" } },
			);
			await expect(forwardedSession.json()).resolves.toMatchObject({
				authenticated: true,
				authRequired: false,
			});
			await expect(upgradeStatus(port, "/")).resolves.toBe(426);
			await expect(
				upgradeStatus(port, `/?wireVersion=${WIRE_PROTOCOL_VERSION}`),
			).resolves.toBe(101);
			await expect(
				upgradeStatus(port, `/?wireVersion=${WIRE_PROTOCOL_VERSION}`, {
					"X-Forwarded-Host": "serve.example.test",
				}),
			).resolves.toBe(101);
		} finally {
			await disposeRuntime(runtime);
		}
	});

	it("binds protected servers without existing tokens and rejects requests", async () => {
		const port = await freePort();
		const runtime = makeRuntime({ policy: "protected", port });
		try {
			await runtime.runPromise(Effect.void);
			const response = await fetch(`http://127.0.0.1:${port}/`);
			expect(response.status).toBe(401);
			await expect(upgradeStatus(port, "/")).resolves.toBe(401);
		} finally {
			await disposeRuntime(runtime);
		}
	});
});
