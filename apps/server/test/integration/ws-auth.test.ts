import { randomBytes } from "node:crypto";
import { createServer, Socket } from "node:net";
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
	const ProtocolLayer = wsServerProtocolLayer({
		port: opts.port,
		host: "127.0.0.1",
		onListening: opts.onListening,
	}).pipe(Layer.provide(LanAuthLayer));
	const ServerLayer = RpcServer.layer(TestRpcs).pipe(
		Layer.provide(PingHandler),
		Layer.provide(ProtocolLayer),
	);
	return ManagedRuntime.make(Layer.mergeAll(LanAuthLayer, ServerLayer));
};

const disposeRuntime = async (
	runtime: ManagedRuntime.ManagedRuntime<any, any>,
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
			await expect(upgradeStatus(port, "/")).resolves.toBe(426);
			await expect(
				upgradeStatus(port, `/?wireVersion=${WIRE_PROTOCOL_VERSION}`),
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
