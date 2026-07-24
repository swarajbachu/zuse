import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { createServer, Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AttachmentService } from "@zuse/agents/kernel/attachment-service";
import { PingResult, PingRpc, WIRE_PROTOCOL_VERSION } from "@zuse/contracts";
import { layer as sqliteLayer } from "@zuse/sqlite";
import { Effect, Layer, ManagedRuntime } from "effect";
import { RpcGroup, RpcServer } from "effect/unstable/rpc";
import { describe, expect, it } from "vitest";

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
import { wsServerProtocolLayer } from "../../src/transports/ws.ts";

const TestRpcs = RpcGroup.make(PingRpc);

const PingHandler = TestRpcs.toLayerHandler("ping.ping", () =>
	Effect.succeed(PingResult.make({ message: "pong", receivedAt: new Date() })),
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
}) => {
	const SqlLive = sqliteLayer({ filename: ":memory:" });
	const Migrated = Layer.effectDiscard(
		Migration0021AuthTokens.pipe(
			Effect.andThen(Migration0024RemoteConnectState),
			Effect.andThen(Migration0025RelayEnvironmentKeys),
			Effect.andThen(Migration0028RelayMintPublicKey),
			Effect.andThen(Migration0039AuthTokenDevices),
			Effect.andThen(Migration0040BlockedNearbyDevices),
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
		readPath: () => Effect.succeed(null),
	});
	const ProtocolLayer = wsServerProtocolLayer({
		port: opts.port,
		host: "127.0.0.1",
		onListening: opts.onListening,
		staticDir: opts.staticDir,
		trustProxy: opts.trustProxy,
	}).pipe(Layer.provide(Layer.merge(LanAuthLayer, AttachmentLayer)));
	const ServerLayer = RpcServer.layer(TestRpcs).pipe(
		Layer.provide(PingHandler),
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

const upgradeStatus = (
	port: number,
	path: string,
	headers: Readonly<Record<string, string>> = {},
): Promise<number> =>
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
			const status = Number(data.split(" ")[1]);
			resolve(status);
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

describe("WS LAN auth", () => {
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

	it("rejects unauthenticated protected requests before upgrade", async () => {
		const port = await freePort();
		const runtime = makeRuntime({
			policy: "protected",
			port,
			pairingBootstrap: true,
		});
		try {
			await runtime.runPromise(Effect.void);
			const response = await fetch(`http://127.0.0.1:${port}/`);
			expect(response.status).toBe(401);
			await expect(upgradeStatus(port, "/")).resolves.toBe(401);
		} finally {
			await disposeRuntime(runtime);
		}
	});

	it("redeems pairing codes and accepts query-token WebSockets", async () => {
		const port = await freePort();
		const runtime = makeRuntime({
			policy: "protected",
			port,
			pairingBootstrap: true,
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
